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
import type { HttpFetcher } from "../fetch-port";
import { normalizeArxivId, normalizeDoi } from "../identifiers";
import { nodeHttpFetcher } from "../node-http-fetcher";
import { excludeCaptured, mergeCandidates, mergeSeeds } from "./candidate";
import type { CandidateSeed } from "./candidate";
import { dropAlreadyIdentified } from "./dedup-identified";
import { crossCheckIdentifiedSeed } from "./identity-crosscheck";
import { matchViaCrossrefTitle } from "./title-resolution";
import {
  footnoteMarkersIn,
  parseFootnoteDefinitions,
  type FootnoteDefinition,
} from "./footnotes";
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
 * DELIBERATE DIVERGENCE from extraction's hard preflight gate
 * (run-source-extraction.ts): an unusable primary backend NEVER blocks this
 * run. The regex channel alone is still a complete (if narrower) scan, so
 * the run always starts once its OWN preconditions hold (briefing imported)
 * and simply degrades to regex-only — recorded both in the completion reason
 * AND in the durable pointer's `method` field ("regex" vs. "regex+llm"), so
 * the degradation is visible without reading event prose. Crossref failures
 * are absorbed the same way, one level down (see crossref.ts) — nothing here
 * ever throws because a remote service was unavailable.
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
  const footnotes = parseFootnoteDefinitions(briefingText);
  const footnoteByMarker = new Map(footnotes.map((def) => [def.marker, def]));

  // A footnote whose marker also appears inline next to a URL/DOI IS that
  // inline source (Elicit cites each source both ways). Its marker is
  // "claimed": the footnote's title enriches the identifier candidate below,
  // and its separate report by the LLM/footnote channel is a duplicate.
  const claimedMarkers = new Set<string>();
  for (const hit of regexHits) {
    for (const marker of footnoteMarkersIn(hit.raw_text)) {
      if (footnoteByMarker.has(marker)) {
        claimedMarkers.add(marker);
      }
    }
  }

  const regexSeeds: CandidateSeed[] = regexHits.map((hit) => {
    const def = footnoteMarkersIn(hit.raw_text)
      .map((marker) => footnoteByMarker.get(marker))
      .find((entry): entry is FootnoteDefinition => entry !== undefined);
    return {
      raw_text: hit.raw_text,
      method: hit.method,
      ...(hit.doi ? { doi: hit.doi } : {}),
      ...(hit.arxiv_id ? { arxiv_id: hit.arxiv_id } : {}),
      ...(hit.url ? { url: hit.url } : {}),
      // The footnote for this citation's marker gives the inline URL/DOI a
      // title it otherwise lacks (a bare URL has none).
      ...(def?.title ? { title: def.title } : {}),
    };
  });

  let parsed: ParsedReference[] = [];
  let method: "regex" | "regex+llm" = "regex";
  let degradationNote = "";

  if (context.backendUsable) {
    // Only identifier spans are hidden from the LLM; footnote titles are left
    // visible so the model reports (and enriches) them as it normally would.
    const alreadyDetected = regexHits.map((hit) => hit.matchedText);
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
      degradationNote = ` KI-Kanal übersprungen (Rate-Limit: ${outcome.reason}).`;
    } else {
      degradationNote = ` KI-Kanal übersprungen (erschöpft: ${outcome.lastError.message}).`;
    }
  } else {
    degradationNote = ` KI-Kanal übersprungen (Backend nicht einsatzbereit: ${context.backendHint ?? "unbekannt"}).`;
  }

  // De-dup units: the briefing paragraphs that carry an inline identifier,
  // plus the footnote definitions already claimed by an inline identifier
  // (their titles now live on the identifier candidate). An LLM citation that
  // re-reports either — the same paragraph in prose, or the same footnote
  // definition — is a duplicate of the identifier candidate and dropped.
  const identifierSpans = regexHits.map((hit) => hit.matchedText);
  const identifiedParagraphs = briefingText
    .split(/\r?\n\s*\r?\n/)
    .filter((paragraph) =>
      identifierSpans.some((span) => paragraph.includes(span)),
    );
  const claimedFootnoteTexts = footnotes
    .filter((def) => claimedMarkers.has(def.marker))
    .map((def) => def.rawText);
  // The identifiers themselves, as the regex channel canonicalized them —
  // the join for prompt v1.1.0's re-report of an already-detected citation,
  // which is kept precisely because it merges (see dedup-identified.ts).
  const knownIdentifiers = regexHits
    .map((hit) => hit.doi ?? hit.arxiv_id ?? hit.url)
    .filter((value): value is string => value !== undefined);
  const parsedNew = dropAlreadyIdentified(
    parsed,
    [...identifiedParagraphs, ...claimedFootnoteTexts],
    identifierSpans,
    knownIdentifiers,
  );
  const parsedWithIdentifier = parsedNew.filter(
    (reference) => reference.doi || reference.arxiv_id || reference.url,
  );
  const parsedWithoutIdentifier = parsedNew.filter(
    (reference) => !reference.doi && !reference.arxiv_id && !reference.url,
  );
  const parsedIdentifiedSeeds: CandidateSeed[] = parsedWithIdentifier.map(
    (reference) => {
      // Canonicalized on the way in, through the same normalizers the capture
      // path uses. The model writes an identifier the way the briefing did —
      // "arXiv:2401.12345", or an arxiv.org URL — while the regex channel
      // stores the bare id, and `identityKey` is a string comparison: an
      // uncanonicalized echo would mint its own key and stand as a SECOND
      // candidate for the same paper instead of merging into the first,
      // taking its title with it. A value that normalizes to nothing is kept
      // as written; it is then simply an identifier the merge does not know.
      const doi = reference.doi
        ? (normalizeDoi(reference.doi) ?? reference.doi)
        : undefined;
      const arxivId = reference.arxiv_id
        ? (normalizeArxivId(reference.arxiv_id) ?? reference.arxiv_id)
        : undefined;
      return {
        raw_text: reference.raw_text,
        method: doi ? "doi" : arxivId ? "arxiv" : "url",
        ...(doi ? { doi } : {}),
        ...(arxivId ? { arxiv_id: arxivId } : {}),
        ...(reference.url ? { url: reference.url } : {}),
        authors: reference.authors,
        ...(reference.year !== undefined ? { year: reference.year } : {}),
        title: reference.title,
        ...(reference.venue ? { venue: reference.venue } : {}),
      };
    },
  );

  // Footnote definitions WITHOUT an inline identifier are references with no
  // pasted link; they feed the same Crossref title-resolution as the LLM's
  // identifier-less citations — but only when the LLM channel did NOT run (it
  // reads the footnotes itself). Claimed footnotes are already represented by
  // their inline identifier candidate, so they are skipped here.
  const footnoteReferences: ParsedReference[] =
    method === "regex"
      ? footnotes
          .filter((def) => !claimedMarkers.has(def.marker))
          .map((def) => ({
            raw_text: def.rawText,
            authors: [],
            title: def.title,
          }))
      : [];

  // Pre-filter against already-captured sources BEFORE any Crossref lookup
  // (quota) — both the identified pool and the identifier-less pool headed
  // for Crossref.
  const identifiedPool = excludeCaptured(
    [...regexSeeds, ...parsedIdentifiedSeeds],
    register.sources,
  );
  // Merged BEFORE the cross-check, not after. The two channels report one
  // citation as two seeds — the regex hit carries the identifier and (unless
  // a footnote supplied one) no title, the LLM's report of the same citation
  // carries the title. Checking them unmerged would resolve the identifier
  // twice over the network and let only the titled half compare anything,
  // and the verdict would then have to survive the merge that follows. One
  // merged seed per identifier, checked once, against everything the scan
  // knows about it.
  const mergedIdentified = mergeSeeds(identifiedPool);
  // Identity cross-check (automatic repair): every DOI/arXiv seed that
  // carries a cited title gets its identifier's resolved metadata compared
  // against that title BEFORE it can be auto-captured — the preventive
  // guard against hallucinated identifiers that resolve to a real but
  // wrong work. Sequential like every other remote loop here; failures
  // fail open inside the check.
  const preCrossrefPool: CandidateSeed[] = [];
  for (const seed of mergedIdentified) {
    preCrossrefPool.push(
      await crossCheckIdentifiedSeed(seed, context.fetcher, context.sleep),
    );
  }
  const remainingWithoutIdentifier = excludeCaptured(
    [...parsedWithoutIdentifier, ...footnoteReferences],
    register.sources,
  );

  const crossrefSeeds: CandidateSeed[] = [];
  for (const reference of remainingWithoutIdentifier) {
    const resolution = await matchViaCrossrefTitle(
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
