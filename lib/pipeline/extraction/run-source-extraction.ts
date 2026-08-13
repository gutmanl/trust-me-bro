import { renderPromptForJob } from "../../adapters";
import type {
  ExtractionInput,
  JobRequest,
  KnownClaimContext,
  Orchestrator,
  SourceContext,
} from "../../adapters";
import { loadAdapterConfig } from "../../identity";
import { splitBriefingParagraphs } from "../../register";
import type {
  BriefingImport,
  ClaimsRegister,
  RegisterStore,
  Source,
} from "../../register";
import { ExtractionPreconditionError, UnknownSourceError } from "../errors";
import { permissiveBackendPreflight, probeBackendUsable } from "../health";
import type { BackendPreflight } from "../health";
import { requireProjectStore } from "../projects";
import { briefingRenderContext } from "../research/independence";
import { buildProjectOrchestrator } from "../runs/build-orchestrator";
import { getGlobalJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import type { RunHandle } from "../runs/types";
import { formatCitation } from "../sources/csl";
import { applyExtractionOutput } from "./apply-extraction-output";
import { EXTRACTION_ACTOR, EXTRACTION_FAILED_PREFIX } from "./derive-state";

const ACTOR = EXTRACTION_ACTOR;

export interface SourceExtractionDependencies {
  orchestrator?: Orchestrator;
  runner?: JobRunner;
  /** TMB-49 test seam; defaults to permissive when an orchestrator is
   * injected (a mock never talks to real CLIs), else to the real probe. */
  preflight?: BackendPreflight;
}

export interface SourceExtractionSummary {
  outcome: "completed" | "failed";
  created: number;
  /** Evidence entries attached to claims that already existed. */
  merged: number;
  message: string;
}

/**
 * One extraction pass scoped to one captured source (workbench epic).
 * Preconditions: briefing imported; source exists. Deliberately NO
 * once-per-project gate — a source captured later, a revised briefing or a
 * changed prompt are all reasons to run the pass again, and the
 * in-transaction dedupe of `applyExtractionOutput` is what keeps a repeat
 * from duplicating claims. Bracketed by batch_run_started /
 * batch_run_completed (reason names the source id); the claims and the
 * closing bracket land in ONE transaction, so a rejected bundle leaves zero
 * claims behind, never a partial merge.
 */
export async function startSourceExtraction(
  projectId: string,
  sourceId: string,
  deps: SourceExtractionDependencies = {},
): Promise<RunHandle<SourceExtractionSummary>> {
  return start(projectId, sourceId, deps);
}

/**
 * Sweep pass for claims that cite no captured source at all
 * (`target_source: null`), triggered manually. Its claims arrive without
 * evidence and the creation gate routes them to adjudication — the workshop
 * makes unevidenced statements visible instead of dropping them.
 */
export async function startUnevidencedExtraction(
  projectId: string,
  deps: SourceExtractionDependencies = {},
): Promise<RunHandle<SourceExtractionSummary>> {
  return start(projectId, null, deps);
}

async function start(
  projectId: string,
  sourceId: string | null,
  deps: SourceExtractionDependencies,
): Promise<RunHandle<SourceExtractionSummary>> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const briefing = register.project.briefing_import;
  if (!briefing) {
    throw new ExtractionPreconditionError(
      "Vor der Extraktion muss das Briefing importiert sein.",
    );
  }
  const target =
    sourceId === null
      ? null
      : register.sources.find((source) => source.id === sourceId);
  if (sourceId !== null && !target) {
    throw new UnknownSourceError(sourceId);
  }
  // Preflight (TMB-49): a run against an unusable primary CLI is refused
  // BEFORE it starts — with the targeted setup hint, not a mid-run error.
  const preflight =
    deps.preflight ??
    (deps.orchestrator ? permissiveBackendPreflight : probeBackendUsable);
  const primaryReady = await preflight(register.config.backends.primary.cli);
  if (!primaryReady.usable) {
    throw new ExtractionPreconditionError(
      `Primäres Backend nicht einsatzbereit: ${primaryReady.hint ?? "unbekannt"}`,
    );
  }

  const runner = deps.runner ?? getGlobalJobRunner();
  const orchestrator =
    deps.orchestrator ?? buildProjectOrchestrator(register.config);
  const item = sourceId ?? "unevidenced";

  return runner.submit(
    projectId,
    [item],
    () => item,
    (_item, { runId }) =>
      runPassOnce({
        store,
        register,
        briefing,
        target: target ?? null,
        orchestrator,
        backendId: register.config.backends.primary.cli,
        timeoutMs: loadAdapterConfig().timeoutMs,
        runId,
      }),
    { kind: "extraction" },
  );
}

interface PassContext {
  store: RegisterStore;
  register: ClaimsRegister;
  briefing: BriefingImport;
  target: Source | null;
  orchestrator: Orchestrator;
  backendId: string;
  timeoutMs: number;
  runId: string;
}

const sourceContext = (source: Source): SourceContext => ({
  id: source.id,
  citation: formatCitation(source),
});

async function runPassOnce(
  context: PassContext,
): Promise<SourceExtractionSummary> {
  const { store, register, briefing, target, backendId, runId } = context;
  const scope = target ? `Quelle ${target.id}` : "Sweep nachweisloser Aussagen";

  await store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "batch_run_started",
      reason: `Claim-Extraktion gestartet (${scope}, Backend ${backendId}, Lauf ${runId}).`,
      actor: ACTOR,
      ...(target !== null ? { source_id: target.id } : {}),
    });
  });

  const input: ExtractionInput = {
    research_question: register.project.research_question,
    briefing_text: store.blobs().readText(briefing.blob_path),
    sources: register.sources.map(sourceContext),
    target_source: target ? sourceContext(target) : null,
    // Discarded claims are omitted on purpose: they are the ones a human
    // rejected, and the dedupe likewise refuses to revive them — naming them
    // as "already known" would suppress a legitimate re-extraction instead.
    known_claims: register.claims
      .filter((claim) => claim.status !== "discarded")
      .map((claim): KnownClaimContext => ({
        id: claim.id,
        text: claim.text,
        claim_type: claim.claim_type,
      })),
  };
  const job: JobRequest<"extraction"> = {
    kind: "extraction",
    projectDir: store.projectDir,
    input,
    prompt: renderPromptForJob("extraction", input),
    timeoutMs: context.timeoutMs,
  };

  // Impure work strictly outside the transaction.
  const outcome = await context.orchestrator.run(backendId, job);

  if (outcome.status !== "ok") {
    const message =
      outcome.status === "paused"
        ? `Lauf pausiert (Rate-Limit): ${outcome.reason} – später erneut starten.`
        : `Extraktion nach ${outcome.attempts} Versuch(en) erschöpft: ${outcome.lastError.message}`;
    await recordFailedCompletion(store, scope, runId, message, target?.id);
    return { outcome: "failed", created: 0, merged: 0, message };
  }

  try {
    const summary = await store.transaction((tx) =>
      applyExtractionOutput(
        tx,
        outcome.output,
        splitBriefingParagraphs(input.briefing_text),
        {
          backendId,
          model: outcome.model,
          runId,
          targetSourceId: target?.id ?? null,
        },
      ),
    );
    await store.renderBriefingFile(briefingRenderContext(await store.read()));
    return {
      outcome: "completed",
      created: summary.created,
      merged: summary.merged,
      message:
        `${summary.created} neue(r) Claim(s), ${summary.merged} zusätzliche ` +
        `Fundstelle(n), ${summary.recheckPulled.length} Claim(s) zur Nachprüfung.` +
        (summary.droppedUnknownSourceEvidence > 0
          ? ` ${summary.droppedUnknownSourceEvidence} Fundstelle(n) mit ` +
            "unbekannter Quellen-Id verworfen."
          : ""),
    };
  } catch (error) {
    // The register rejected the bundle as a whole (unknown source
    // references, schema violations, a forbidden transition) — nothing was
    // written; the completion event documents the model violation.
    const message = `Extraktionsergebnis vom Register zurückgewiesen: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await recordFailedCompletion(store, scope, runId, message, target?.id);
    return { outcome: "failed", created: 0, merged: 0, message };
  }
}

async function recordFailedCompletion(
  store: RegisterStore,
  scope: string,
  runId: string,
  message: string,
  sourceId?: string,
): Promise<void> {
  await store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "batch_run_completed",
      reason: `${EXTRACTION_FAILED_PREFIX} beendet (${scope}, Lauf ${runId}): ${message}`,
      actor: ACTOR,
      ...(sourceId !== undefined ? { source_id: sourceId } : {}),
    });
  });
}
