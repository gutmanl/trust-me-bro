import { createProjectOrchestrator, renderPromptForJob } from "../../adapters";
import type {
  ExtractionInput,
  ExtractionOutput,
  JobRequest,
  Orchestrator,
  SourceContext,
} from "../../adapters";
import { loadAdapterConfig } from "../../identity";
import { isAtomicClaimText } from "../../register";
import type {
  BriefingImport,
  ClaimsRegister,
  Evidence,
  RegisterStore,
  RegisterTransaction,
} from "../../register";
import {
  ExtractionAlreadyRanError,
  ExtractionPreconditionError,
} from "../errors";
import { evidenceIdAt, nextClaimId } from "../ids";
import { requireProjectStore } from "../projects";
import { getGlobalJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import type { RunHandle } from "../runs/types";
import { isSourceSetFrozen } from "../sources/capture";
import { formatCitation } from "../sources/csl";
import { deriveExtractionState } from "./derive-state";
import type { ExtractionState } from "./derive-state";

const ACTOR = "system:extraction" as const;

export interface ExtractionDependencies {
  orchestrator?: Orchestrator;
  runner?: JobRunner;
}

export interface ExtractionRunSummary {
  outcome: "abgeschlossen" | "fehlgeschlagen";
  claimsCreated: number;
  claimsEscalated: number;
  message: string;
}

/**
 * Starts the claim extraction (TMB-25) on the in-process job runner and
 * returns its handle. The run is bracketed by batch_run_started /
 * batch_run_completed project events; a successful run applies the WHOLE
 * extraction output plus the completion event in one register transaction —
 * a rejected bundle (schema, referential integrity, atomicity of the
 * transaction) therefore leaves zero claims behind, never a partial merge.
 */
export async function startExtraction(
  projectId: string,
  deps: ExtractionDependencies = {},
): Promise<RunHandle<ExtractionRunSummary>> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const briefing = register.project.briefing_import;
  if (!briefing) {
    throw new ExtractionPreconditionError(
      "Vor der Extraktion muss das Briefing importiert sein.",
    );
  }
  if (!isSourceSetFrozen(register)) {
    throw new ExtractionPreconditionError(
      "Vor der Extraktion muss der Quellenbestand eingefroren sein.",
    );
  }
  if (register.claims.length > 0) {
    throw new ExtractionAlreadyRanError(projectId);
  }

  const runner = deps.runner ?? getGlobalJobRunner();
  const orchestrator =
    deps.orchestrator ?? createProjectOrchestrator(register.config);
  const backendId = register.config.backends.primary.cli;
  const timeoutMs = loadAdapterConfig().timeoutMs;

  return runner.submit(
    projectId,
    ["briefing"],
    () => "briefing",
    (_item, { runId }) =>
      runExtractionOnce({
        store,
        register,
        briefing,
        orchestrator,
        backendId,
        timeoutMs,
        runId,
      }),
  );
}

/** Register-derived extraction state plus live-run knowledge, for UI/SSE. */
export function getExtractionState(
  register: ClaimsRegister,
  deps: { runner?: JobRunner } = {},
): ExtractionState {
  const runner = deps.runner ?? getGlobalJobRunner();
  return deriveExtractionState(register, runner.isRunning(register.project.id));
}

/** The live (or latest) run handle of a project, for the SSE stream. */
export function getExtractionRun(
  projectId: string,
  deps: { runner?: JobRunner } = {},
): RunHandle | undefined {
  return (deps.runner ?? getGlobalJobRunner()).currentRun(projectId);
}

interface RunContext {
  store: RegisterStore;
  register: ClaimsRegister;
  briefing: BriefingImport;
  orchestrator: Orchestrator;
  backendId: string;
  timeoutMs: number;
  runId: string;
}

async function runExtractionOnce(
  context: RunContext,
): Promise<ExtractionRunSummary> {
  const { store, register, briefing, orchestrator, backendId, runId } = context;

  await store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "batch_run_started",
      reason: `Claim-Extraktion gestartet (Backend ${backendId}, Lauf ${runId}).`,
      actor: ACTOR,
    });
  });

  const input: ExtractionInput = {
    research_question: register.project.research_question,
    briefing_text: store.blobs().readText(briefing.blob_path),
    sources: register.sources.map((source): SourceContext => ({
      id: source.id,
      citation: formatCitation(source),
    })),
  };
  const job: JobRequest<"extraction"> = {
    kind: "extraction",
    projectDir: store.projectDir,
    input,
    prompt: renderPromptForJob("extraction", input),
    timeoutMs: context.timeoutMs,
  };

  const outcome = await orchestrator.run(backendId, job);

  if (outcome.status !== "ok") {
    const message =
      outcome.status === "paused"
        ? `Lauf pausiert (Rate-Limit): ${outcome.reason} – später erneut starten.`
        : `Extraktion nach ${outcome.attempts} Versuch(en) erschöpft: ${outcome.lastError.message}`;
    await recordFailedCompletion(store, runId, message);
    return {
      outcome: "fehlgeschlagen",
      claimsCreated: 0,
      claimsEscalated: 0,
      message,
    };
  }

  try {
    const summary = await store.transaction((tx) =>
      applyExtractionOutput(tx, outcome.output, {
        backendId,
        model: outcome.model,
        runId,
      }),
    );
    await store.renderBriefingFile();
    return summary;
  } catch (error) {
    // The register rejected the bundle as a whole (duplicate ids, unknown
    // source references, schema violations) — nothing was written; the
    // completion event documents the model violation.
    const message = `Extraktionsergebnis vom Register zurückgewiesen: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await recordFailedCompletion(store, runId, message);
    return {
      outcome: "fehlgeschlagen",
      claimsCreated: 0,
      claimsEscalated: 0,
      message,
    };
  }
}

async function recordFailedCompletion(
  store: RegisterStore,
  runId: string,
  message: string,
): Promise<void> {
  await store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "batch_run_completed",
      reason: `Claim-Extraktion ohne Ergebnis beendet (Lauf ${runId}): ${message}`,
      actor: ACTOR,
    });
  });
}

function applyExtractionOutput(
  tx: RegisterTransaction,
  output: ExtractionOutput,
  meta: { backendId: string; model: string; runId: string },
): ExtractionRunSummary {
  const now = new Date().toISOString();
  const existingIds = tx.listClaims().map((claim) => claim.id);
  let escalated = 0;

  for (const extracted of output.claims) {
    const claimId = nextClaimId(existingIds);
    existingIds.push(claimId);
    const evidence: Evidence[] = extracted.evidence.map((entry, index) => ({
      id: evidenceIdAt(index),
      source_id: entry.source_id,
      locator: entry.locator,
      verbatim_excerpt: entry.verbatim_excerpt,
      judgments: [],
    }));
    // The creation gate decides the status; the reason classifies the
    // routing for the history (unbelegt vs. gebündelt vs. regulär).
    const reason =
      extracted.evidence.length === 0
        ? "Keine Fundstelle extrahierbar – unbelegter Claim zur Adjudikation."
        : isAtomicClaimText(extracted.text)
          ? "Aus dem eingefrorenen Briefing extrahiert."
          : "Atomaritätsgate: Extraktionsergebnis bündelt mehrere Aussagen – zur Adjudikation.";
    const claim = tx.addClaim({
      claim: {
        id: claimId,
        text: extracted.text,
        claim_type: extracted.claim_type,
        briefing_anchor: extracted.briefing_anchor,
        provenance: {
          tool: meta.backendId,
          model: meta.model,
          extracted_at: now,
          search_path: `Extraktionslauf ${meta.runId}`,
        },
        evidence,
      },
      actor: ACTOR,
      reason,
      at: now,
    });
    if (claim.status === "zur_adjudikation") {
      escalated += 1;
    }
  }

  tx.recordProjectEvent({
    event: "batch_run_completed",
    reason:
      `Claim-Extraktion abgeschlossen (Lauf ${meta.runId}): ` +
      `${output.claims.length} Claim(s), davon ${escalated} zur Adjudikation.`,
    actor: ACTOR,
    at: now,
  });

  return {
    outcome: "abgeschlossen",
    claimsCreated: output.claims.length,
    claimsEscalated: escalated,
    message: `${output.claims.length} Claim(s) extrahiert, ${escalated} zur Adjudikation.`,
  };
}
