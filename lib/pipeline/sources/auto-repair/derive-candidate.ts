import {
  createProjectOrchestrator,
  renderPromptForJob,
} from "../../../adapters";
import type {
  JobRequest,
  Orchestrator,
  ReferenceParseInput,
} from "../../../adapters";
import { loadAdapterConfig } from "../../../identity";
import type { ClaimsRegister } from "../../../register";
import type { RepairAction } from "../../../register/schema/history";
import { permissiveBackendPreflight, probeBackendUsable } from "../../health";
import type { BackendPreflight } from "../../health";
import type { HttpFetcher } from "../fetch-port";
import { cleanReferenceTitle } from "../reference-scan/reference-title";
import { matchViaCrossrefTitle } from "../reference-scan/title-resolution";
import type { TitleMatch } from "../reference-scan/title-resolution";

/** What a citation line yields for re-resolution: the same shape the
 * Crossref title matcher scores against. */
export interface DerivedCitationMeta {
  title?: string;
  authors: string[];
  year?: number;
}

export interface DeriveCitationDependencies {
  orchestrator: Orchestrator;
  backendId: string;
  backendUsable: boolean;
  timeoutMs: number;
  projectDir: string;
}

/**
 * Re-derives citation metadata from a raw citation line (automatic
 * repair): the LLM `reference_parse` job when the primary backend is
 * usable and returns exactly one parsed reference; otherwise — no backend,
 * rate-limited, exhausted, ambiguous parse — the deterministic title
 * cleaner as the floor. Never blocks: a noisier query just clears the
 * Crossref confidence bar less often, which is the safe direction.
 */
export async function deriveCitationMeta(
  rawText: string,
  deps: DeriveCitationDependencies,
): Promise<DerivedCitationMeta> {
  const fallback: DerivedCitationMeta = {
    title: cleanReferenceTitle(rawText),
    authors: [],
  };
  if (!deps.backendUsable) {
    return fallback;
  }
  const input: ReferenceParseInput = {
    briefing_text: rawText,
    already_detected: [],
  };
  const job: JobRequest<"reference_parse"> = {
    kind: "reference_parse",
    projectDir: deps.projectDir,
    input,
    prompt: renderPromptForJob("reference_parse", input),
    timeoutMs: deps.timeoutMs,
  };
  try {
    const outcome = await deps.orchestrator.run(deps.backendId, job);
    if (outcome.status === "ok" && outcome.output.references.length === 1) {
      const reference = outcome.output.references[0];
      return {
        ...(reference.title ? { title: reference.title } : {}),
        authors: reference.authors,
        ...(reference.year !== undefined ? { year: reference.year } : {}),
      };
    }
  } catch {
    // Any adapter-level surprise degrades to the deterministic floor.
  }
  return fallback;
}

export interface RematchDependencies {
  orchestrator?: Orchestrator;
  preflight?: BackendPreflight;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The shared re-resolution core of both automatic-repair evaluators:
 * preflight the primary backend, derive the citation's metadata from its
 * raw text (LLM with deterministic floor), and ask Crossref which work the
 * TITLE describes. The callers only differ in how they judge the match.
 */
export async function rematchCitation(
  rawText: string,
  register: ClaimsRegister,
  projectDir: string,
  fetcher: HttpFetcher,
  deps: RematchDependencies,
): Promise<TitleMatch> {
  const preflight =
    deps.preflight ??
    (deps.orchestrator ? permissiveBackendPreflight : probeBackendUsable);
  const backendId = register.config.backends.primary.cli;
  const primaryReady = await preflight(backendId);
  const orchestrator =
    deps.orchestrator ?? createProjectOrchestrator(register.config);
  const meta = await deriveCitationMeta(rawText, {
    orchestrator,
    backendId,
    backendUsable: primaryReady.usable,
    timeoutMs: loadAdapterConfig().timeoutMs,
    projectDir,
  });
  return matchViaCrossrefTitle(meta, fetcher, deps.sleep);
}

/** The repair-action candidate a title rematch yields — one builder so the
 * two evaluators' payloads cannot drift. */
export function repairCandidateOf(
  match: TitleMatch & { doi: string },
  documentUrl: string | undefined,
): RepairAction["candidate"] {
  return {
    kind: "doi",
    identifier: match.doi,
    ...(documentUrl ? { document_url: documentUrl } : {}),
    ...(match.title ? { title: match.title } : {}),
  };
}
