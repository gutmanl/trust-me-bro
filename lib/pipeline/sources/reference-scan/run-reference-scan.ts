import {
  createProjectOrchestrator,
  renderPromptForJob,
} from "../../../adapters";
import type {
  JobRequest,
  Orchestrator,
  ParsedReference,
  ReferenceParseInput,
} from "../../../adapters";
import { loadAdapterConfig } from "../../../identity";
import type { ClaimsRegister, RegisterStore } from "../../../register";
import { ReferenceScanPreconditionError } from "../../errors";
import { permissiveBackendPreflight, probeBackendUsable } from "../../health";
import type { BackendPreflight } from "../../health";
import { requireProjectStore } from "../../projects";
import { getGlobalJobRunner } from "../../runs/job-runner";
import type { JobRunner } from "../../runs/job-runner";
import type { RunHandle } from "../../runs/types";
import { isSourceSetFrozen } from "../capture";
import type { HttpFetcher } from "../fetch-port";
import { nodeHttpFetcher } from "../node-http-fetcher";
import { excludeCaptured, mergeCandidates } from "./candidate";
import type { CandidateSeed } from "./candidate";
import type { CrossrefWork } from "./crossref";
import { searchCrossref } from "./crossref";
import { MATCH_FLOOR, scoreMatch } from "./crossref-match";
import { cleanReferenceTitle } from "./reference-title";
import { deriveDocumentUrl } from "./derive-document-url";
import { deriveReferenceScanState } from "./derive-state";
import type { ReferenceScanState } from "./derive-state";
import { scanRegex } from "./scan-regex";
import { ReferenceScanResult } from "./schema";
import type { ReferenceCandidate } from "./schema";

const ACTOR = "system:reference_scan" as const;

export interface ReferenceScanDependencies {
  orchestrator?: Orchestrator;
  runner?: JobRunner;
  /** TMB-49-style test seam; defaults to permissive when an orchestrator is
   * injected, else to the real probe — mirrors extraction/relevance. Here
   * the probe result NEVER blocks the run, only decides regex-only vs.
   * regex+llm (see the module doc comment below). */
  preflight?: BackendPreflight;
  fetcher?: HttpFetcher;
  /** Crossref Retry-After wait, injectable so tests never sleep for real. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ReferenceScanRunSummary {
  method: "regex" | "regex+llm";
  candidateCount: number;
  message: string;
}

/**
 * Starts the reference scan of the frozen briefing (reference auto-import):
 * the regex channel deterministically finds DOI/arXiv/URL spans, an
 * OPTIONAL LLM channel additionally hunts textual citations the regex
 * missed, and Crossref resolves citations without their own identifier to a
 * candidate DOI by title/author/year similarity.
 *
 * DELIBERATE DIVERGENCE from extraction's hard preflight gate (run-
 * extraction.ts): an unusable primary backend NEVER blocks this run. The
 * regex channel alone is still a complete (if narrower) scan, so the run
 * always starts once its OWN preconditions hold (briefing imported, source
 * set not yet frozen) and simply degrades to regex-only — recorded both in
 * the completion reason AND in the durable pointer's `method` field
 * ("regex" vs. "regex+llm"), so the degradation is visible without reading
 * event prose. Crossref failures are absorbed the same way, one level
 * down (see crossref.ts) — nothing here ever throws because a remote
 * service was unavailable.
 */
export async function startReferenceScan(
  projectId: string,
  deps: ReferenceScanDependencies = {},
): Promise<RunHandle<ReferenceScanRunSummary>> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const briefing = register.project.briefing_import;
  if (!briefing) {
    throw new ReferenceScanPreconditionError(
      "Vor dem Referenz-Scan muss ein Briefing importiert sein.",
    );
  }
  if (isSourceSetFrozen(register)) {
    throw new ReferenceScanPreconditionError(
      "Der Quellenbestand ist bereits eingefroren.",
    );
  }

  const preflight =
    deps.preflight ??
    (deps.orchestrator ? permissiveBackendPreflight : probeBackendUsable);
  const primaryReady = await preflight(register.config.backends.primary.cli);

  const runner = deps.runner ?? getGlobalJobRunner();
  const orchestrator =
    deps.orchestrator ?? createProjectOrchestrator(register.config);
  const backendId = register.config.backends.primary.cli;
  const timeoutMs = loadAdapterConfig().timeoutMs;
  const fetcher = deps.fetcher ?? nodeHttpFetcher;

  return runner.submit(
    projectId,
    ["briefing"],
    () => "briefing",
    (_item, { runId }) =>
      runReferenceScanOnce({
        store,
        register,
        briefingText: store.blobs().readText(briefing.blob_path),
        backendUsable: primaryReady.usable,
        backendHint: primaryReady.hint,
        orchestrator,
        backendId,
        timeoutMs,
        fetcher,
        sleep: deps.sleep,
        runId,
      }),
    { kind: "reference_scan" },
  );
}

/** Register-derived reference-scan state plus live-run knowledge, for
 * UI/SSE. Keyed by the routing project id like extraction's counterpart. */
export function getReferenceScanState(
  projectId: string,
  register: ClaimsRegister,
  deps: { runner?: JobRunner } = {},
): ReferenceScanState {
  const runner = deps.runner ?? getGlobalJobRunner();
  return deriveReferenceScanState(
    register,
    runner.isRunning(projectId, "reference_scan"),
  );
}

/** The live (or latest) reference-scan run handle, for the SSE stream. */
export function getReferenceScanRun(
  projectId: string,
  deps: { runner?: JobRunner } = {},
): RunHandle | undefined {
  return (deps.runner ?? getGlobalJobRunner()).currentRun(
    projectId,
    "reference_scan",
  );
}

interface RunContext {
  store: RegisterStore;
  register: ClaimsRegister;
  briefingText: string;
  backendUsable: boolean;
  backendHint?: string;
  orchestrator: Orchestrator;
  backendId: string;
  timeoutMs: number;
  fetcher: HttpFetcher;
  sleep?: (ms: number) => Promise<void>;
  runId: string;
}

async function runReferenceScanOnce(
  context: RunContext,
): Promise<ReferenceScanRunSummary> {
  const { store, register, briefingText, runId } = context;

  await store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "reference_scan_started",
      reason: `Referenz-Scan gestartet (Lauf ${runId}).`,
      actor: ACTOR,
    });
  });

  const regexHits = scanRegex(briefingText);
  const identifierHits = regexHits.filter((hit) => hit.method !== "textual");
  const footnoteHits = regexHits.filter((hit) => hit.method === "textual");
  const regexSeeds: CandidateSeed[] = identifierHits.map((hit) => ({
    raw_text: hit.raw_text,
    method: hit.method as "doi" | "arxiv" | "url",
    ...(hit.doi ? { doi: hit.doi } : {}),
    ...(hit.arxiv_id ? { arxiv_id: hit.arxiv_id } : {}),
    ...(hit.url ? { url: hit.url } : {}),
  }));

  let parsed: ParsedReference[] = [];
  let method: "regex" | "regex+llm" = "regex";
  let degradationNote = "";

  if (context.backendUsable) {
    // Only identifier spans are hidden from the LLM; footnote titles are left
    // visible so the model reports (and enriches) them as it normally would.
    const alreadyDetected = identifierHits.map((hit) => hit.matchedText);
    const input: ReferenceParseInput = {
      briefing_text: briefingText,
      already_detected: alreadyDetected,
    };
    const job: JobRequest<"reference_parse"> = {
      kind: "reference_parse",
      projectDir: store.projectDir,
      input,
      prompt: renderPromptForJob("reference_parse", input),
      timeoutMs: context.timeoutMs,
    };
    const outcome = await context.orchestrator.run(context.backendId, job);
    if (outcome.status === "ok") {
      parsed = outcome.output.references;
      method = "regex+llm";
    } else if (outcome.status === "paused") {
      degradationNote = ` LLM-Kanal übersprungen (Rate-Limit: ${outcome.reason}).`;
    } else {
      degradationNote = ` LLM-Kanal übersprungen (erschöpft: ${outcome.lastError.message}).`;
    }
  } else {
    degradationNote = ` LLM-Kanal übersprungen (Backend nicht einsatzbereit: ${context.backendHint ?? "unbekannt"}).`;
  }

  const parsedWithIdentifier = parsed.filter(
    (reference) => reference.doi || reference.arxiv_id || reference.url,
  );
  const parsedWithoutIdentifier = parsed.filter(
    (reference) => !reference.doi && !reference.arxiv_id && !reference.url,
  );
  const parsedIdentifiedSeeds: CandidateSeed[] = parsedWithIdentifier.map(
    (reference) => ({
      raw_text: reference.raw_text,
      method: reference.doi ? "doi" : reference.arxiv_id ? "arxiv" : "url",
      ...(reference.doi ? { doi: reference.doi } : {}),
      ...(reference.arxiv_id ? { arxiv_id: reference.arxiv_id } : {}),
      ...(reference.url ? { url: reference.url } : {}),
      authors: reference.authors,
      ...(reference.year !== undefined ? { year: reference.year } : {}),
      title: reference.title,
      ...(reference.venue ? { venue: reference.venue } : {}),
    }),
  );

  // Footnote references from the deterministic channel feed the same
  // Crossref title-resolution as the LLM's identifier-less citations — but
  // only when the LLM channel did NOT run (backend down / rate-limited /
  // exhausted). When it did run, it already read the whole briefing including
  // the footnotes, so adding them here would only duplicate work and rows.
  const footnoteReferences: ParsedReference[] =
    method === "regex"
      ? footnoteHits.map((hit) => ({
          raw_text: hit.raw_text,
          authors: [],
          title: hit.title ?? hit.raw_text,
        }))
      : [];

  // Pre-filter against already-captured sources BEFORE any Crossref lookup
  // (quota) — both the identified pool and the identifier-less pool headed
  // for Crossref.
  const preCrossrefPool = excludeCaptured(
    [...regexSeeds, ...parsedIdentifiedSeeds],
    register.sources,
  );
  const remainingWithoutIdentifier = excludeCaptured(
    [...parsedWithoutIdentifier, ...footnoteReferences],
    register.sources,
  );

  const crossrefSeeds: CandidateSeed[] = [];
  for (const reference of remainingWithoutIdentifier) {
    const resolution = await resolveViaCrossref(
      reference,
      context.fetcher,
      context.sleep,
    );
    const year = resolution.year ?? reference.year;
    const venue = resolution.venue ?? reference.venue;
    crossrefSeeds.push({
      raw_text: reference.raw_text,
      method: resolution.doi ? "crossref_title" : "unresolved",
      ...(resolution.doi ? { doi: resolution.doi } : {}),
      authors: resolution.authors ?? reference.authors,
      ...(year !== undefined ? { year } : {}),
      title: resolution.title ?? reference.title,
      ...(venue ? { venue } : {}),
      ...(resolution.match_score !== undefined
        ? { match_score: resolution.match_score }
        : {}),
      ...(resolution.crossref_unavailable
        ? { crossref_unavailable: true }
        : {}),
    });
  }

  const mergedCandidates = mergeCandidates([
    ...preCrossrefPool,
    ...crossrefSeeds,
  ]);

  // Document-url derivation (reference auto-import, Task 3b): arXiv PDF >
  // Crossref's own PDF link > Unpaywall, per candidate, AFTER merging (so a
  // regex DOI hit and its Crossref-matched textual twin are derived exactly
  // once as the single collapsed candidate). Sequential, not Promise.all —
  // deterministic call order for tests and gentler on Crossref's rate
  // limit. Every failure is absorbed one level down (derive-document-url.ts
  // / crossref.ts / unpaywall.ts): nothing here can turn a scan into an
  // error.
  const candidates: ReferenceCandidate[] = [];
  for (const candidate of mergedCandidates) {
    candidates.push(await attachDocumentUrl(candidate, context));
  }

  const result: ReferenceScanResult = {
    scanned_at: new Date().toISOString(),
    method,
    candidates,
  };
  const validated = ReferenceScanResult.parse(result);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;

  const reason =
    `Referenz-Scan abgeschlossen (Lauf ${runId}): ${candidates.length} ` +
    `Kandidat(en), Methode ${method}.${degradationNote}`;

  // ONE final transaction: the candidates blob AND the pointer commit
  // together — a rejected transaction (schema/chain validation) leaves the
  // PREVIOUS scan's pointer intact; blobs().put is content-addressed and
  // idempotent, so an orphaned blob file from a rejected attempt is
  // harmless, never referenced by anything.
  await store.transaction((tx) => {
    const blob = store.blobs().put(serialized, "json");
    tx.recordReferenceScan({
      sha256: blob.sha256,
      blob_path: blob.blobPath,
      method,
      candidate_count: candidates.length,
      actor: ACTOR,
      reason,
    });
  });

  return { method, candidateCount: candidates.length, message: reason };
}

/** Enriches one candidate with its derived document_url (reference auto-
 * import, Task 3b) — only doi/arxiv/crossref_title candidates carry an
 * identifier to derive from; `url` (its own URL already IS the document to
 * capture) and `unresolved` (no identifier at all) pass through unchanged. */
async function attachDocumentUrl(
  candidate: ReferenceCandidate,
  context: Pick<RunContext, "fetcher" | "sleep">,
): Promise<ReferenceCandidate> {
  if (
    candidate.method !== "doi" &&
    candidate.method !== "arxiv" &&
    candidate.method !== "crossref_title"
  ) {
    return candidate;
  }
  const derived = await deriveDocumentUrl(
    { doi: candidate.doi, arxivId: candidate.arxiv_id },
    { fetcher: context.fetcher, sleep: context.sleep },
  );
  if (!derived.documentUrl) {
    return candidate;
  }
  return {
    ...candidate,
    document_url: derived.documentUrl,
    document_url_source: derived.source,
  };
}

interface CrossrefResolution {
  doi?: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  match_score?: number;
  crossref_unavailable?: boolean;
}

/** Resolves one identifier-less parsed citation via Crossref: Crossref not
 * being reachable/answerable at all (network error, non-200, exhausted 429
 * retry — see crossref.ts's `unavailable` flag) marks the candidate
 * `crossref_unavailable`; a normal response with zero or no confident-enough
 * results leaves it unresolved without that flag (Crossref answered, just
 * found nothing — I3 fix: these two cases used to be conflated because both
 * produced an empty `works` array). */
async function resolveViaCrossref(
  reference: ParsedReference,
  fetcher: HttpFetcher,
  sleep: ((ms: number) => Promise<void>) | undefined,
): Promise<CrossrefResolution> {
  // Clean the title (strip a "| venue" suffix, ellipsis truncation, quotes)
  // before it hits Crossref: it is both the query and the string the bigram
  // similarity scores against Crossref's own clean title.
  const cleanTitle = cleanReferenceTitle(reference.title);
  const query = [cleanTitle, reference.authors.join(" ")]
    .filter((part) => part.trim().length > 0)
    .join(" ");
  const { works, unavailable } = await searchCrossref(
    query,
    fetcher,
    sleep ? { sleep } : {},
  );
  if (unavailable) {
    return { crossref_unavailable: true };
  }

  let best: { work: CrossrefWork; score: number } | undefined;
  for (const work of works) {
    const score = scoreMatch(
      {
        title: cleanTitle,
        year: reference.year,
        authors: reference.authors,
      },
      work,
    );
    if (!best || score > best.score) {
      best = { work, score };
    }
  }
  if (!best || best.score < MATCH_FLOOR || !best.work.doi) {
    return {};
  }
  return {
    doi: best.work.doi,
    title: best.work.title,
    authors: best.work.authors,
    year: best.work.year,
    venue: best.work.venue,
    match_score: best.score,
  };
}
