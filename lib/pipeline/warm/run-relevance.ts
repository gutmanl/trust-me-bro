import { renderPromptForJob } from "../../adapters";
import type { JobRequest, Orchestrator, RelevanceInput } from "../../adapters";
import { loadAdapterConfig } from "../../identity";
import type { ClaimsRegister, RegisterStore } from "../../register";
import { RelevancePreconditionError } from "../errors";
import { permissiveBackendPreflight, probeBackendUsable } from "../health";
import { buildProjectOrchestrator } from "../runs/build-orchestrator";
import type { BackendPreflight } from "../health";
import { requireProjectStore } from "../projects";
import { getGlobalJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import type { RunHandle } from "../runs/types";
import { deriveRelevanceState } from "./derive-state";
import type { RelevanceState } from "./derive-state";
import { pendingRelevancePopulation } from "./select-claims";

/**
 * The relevance check of a warm run (TMB-43): one job-runner item per
 * adopted claim, judging ONLY its bearing on the new research question —
 * existence and attribution stand. Positive judgments leave no register
 * trace (derive, don't store; the closed bracket marks the sweep), negative
 * or uncertain ones route to adjudication with negative_relevance.
 * Persistence, bracket and pause discipline mirror the verification run.
 */

const COMPLETE_ITEM = "__closing__";
const ACTOR_RUN = "system:relevance_run" as const;
const ACTOR_CHECK = "system:relevance_check" as const;

export interface RelevanceDependencies {
  orchestrator?: Orchestrator;
  runner?: JobRunner;
  /** TMB-49 test seam; defaults to permissive when an orchestrator is
   * injected (a mock never talks to real CLIs), else to the real probe. */
  preflight?: BackendPreflight;
}

export type RelevanceItemOutcome =
  | "relevant"
  | "pending_adjudication"
  | "escalated"
  | "paused"
  | "skipped"
  | "closed";

export interface RelevanceItemResult {
  /** Absent for the closing pseudo-item. */
  claimId?: string;
  outcome: RelevanceItemOutcome;
  message: string;
}

interface RunContext {
  store: RegisterStore;
  input: Omit<RelevanceInput, "claim">;
  orchestrator: Orchestrator;
  backendId: string;
  timeoutMs: number;
  projectDir: string;
  totalEligible: number;
  bracket: {
    startedRecorded: boolean;
    pauseReason: string | null;
    kept: number;
    routed: number;
    escalated: number;
    errors: number;
  };
}

/** Starts the relevance check on the in-process job runner. */
export async function startRelevanceCheck(
  projectId: string,
  deps: RelevanceDependencies = {},
): Promise<RunHandle<RelevanceItemResult>> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const population = pendingRelevancePopulation(
    register.claims,
    register.project_events,
  );
  // A dangling bracket is resumable work even when nothing is pending: the
  // recovery run consists of the closing item alone (verification pattern).
  const interrupted =
    deriveRelevanceState(register, false).status === "interrupted";
  if (population.length === 0 && !interrupted) {
    throw new RelevancePreconditionError(
      "Keine übernommenen Aussagen ohne Einschlägigkeitsprüfung – " +
        "nichts zu prüfen.",
    );
  }

  // Preflight (TMB-49): refuse a run against an unusable primary CLI
  // BEFORE it starts, with the targeted setup hint.
  const preflight =
    deps.preflight ??
    (deps.orchestrator ? permissiveBackendPreflight : probeBackendUsable);
  const primaryReady = await preflight(register.config.backends.primary.cli);
  if (!primaryReady.usable) {
    throw new RelevancePreconditionError(
      `Primäres Backend nicht einsatzbereit: ${primaryReady.hint ?? "unbekannt"}`,
    );
  }

  const runner = deps.runner ?? getGlobalJobRunner();
  const context: RunContext = {
    store,
    input: {
      research_question: register.project.research_question,
      previous_research_question: await originResearchQuestion(register),
    },
    orchestrator:
      deps.orchestrator ?? buildProjectOrchestrator(register.config),
    backendId: register.config.backends.primary.cli,
    timeoutMs: loadAdapterConfig().timeoutMs,
    projectDir: store.projectDir,
    totalEligible: population.length,
    bracket: {
      startedRecorded: false,
      pauseReason: null,
      kept: 0,
      routed: 0,
      escalated: 0,
      errors: 0,
    },
  };

  return runner.submit(
    projectId,
    [...population, COMPLETE_ITEM],
    (item) => item,
    async (item, { runId }) => {
      await recordStartedOnce(context, runId);
      if (item === COMPLETE_ITEM) {
        return closeBracket(context, runId);
      }
      try {
        return await processClaim(context, item);
      } catch (error) {
        context.bracket.errors += 1;
        throw error;
      }
    },
    { kind: "relevance" },
  );
}

/** Register-derived relevance state plus live-run knowledge, for UI/SSE. */
export function getRelevanceState(
  projectId: string,
  register: ClaimsRegister,
  deps: { runner?: JobRunner } = {},
): RelevanceState {
  const runner = deps.runner ?? getGlobalJobRunner();
  return deriveRelevanceState(
    register,
    runner.isRunning(projectId, "relevance"),
  );
}

/** The live (or latest) relevance run handle, for the SSE stream. */
export function getRelevanceRun(
  projectId: string,
  deps: { runner?: JobRunner } = {},
): RunHandle | undefined {
  return (deps.runner ?? getGlobalJobRunner()).currentRun(
    projectId,
    "relevance",
  );
}

/** The origin project's research question, for contrast in the prompt; the
 * origin may have been renamed or deleted since adoption — then the check
 * still runs, just without the contrast. */
async function originResearchQuestion(
  register: ClaimsRegister,
): Promise<string> {
  const originId = register.claims.find(
    (claim) => claim.provenance.origin_project_id !== undefined,
  )?.provenance.origin_project_id;
  if (!originId) {
    return "(nicht verfügbar)";
  }
  try {
    const origin = await requireProjectStore(originId).read();
    return origin.project.research_question;
  } catch {
    return "(nicht verfügbar)";
  }
}

async function recordStartedOnce(
  context: RunContext,
  runId: string,
): Promise<void> {
  if (context.bracket.startedRecorded) {
    return;
  }
  await context.store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "relevance_run_started",
      reason: `Einschlägigkeitsprüfung gestartet: ${context.totalEligible} Aussage(n) (Lauf ${runId}).`,
      actor: ACTOR_RUN,
    });
  });
  context.bracket.startedRecorded = true;
}

async function processClaim(
  context: RunContext,
  claimId: string,
): Promise<RelevanceItemResult> {
  const { bracket } = context;
  if (bracket.pauseReason !== null) {
    return {
      claimId,
      outcome: "skipped",
      message: `Übersprungen – Lauf pausiert (${bracket.pauseReason}).`,
    };
  }
  const claim = (await context.store.read()).claims.find(
    (candidate) => candidate.id === claimId,
  );
  if (
    !claim ||
    claim.provenance.origin_project_id === undefined ||
    (claim.status !== "confirmed" && claim.status !== "auto_confirmed")
  ) {
    return {
      claimId,
      outcome: "skipped",
      message: "Übersprungen – Status hat sich seit Laufbeginn geändert.",
    };
  }

  const input: RelevanceInput = {
    ...context.input,
    claim: {
      id: claim.id,
      text: claim.text,
      claim_type: claim.claim_type,
      briefing_anchor: claim.briefing_anchor,
    },
  };
  const job: JobRequest<"relevance"> = {
    kind: "relevance",
    projectDir: context.projectDir,
    input,
    prompt: renderPromptForJob("relevance", input),
    timeoutMs: context.timeoutMs,
  };
  // LLM work strictly outside any transaction.
  const outcome = await context.orchestrator.run(context.backendId, job);

  if (outcome.status === "paused") {
    bracket.pauseReason = outcome.reason;
    return {
      claimId,
      outcome: "paused",
      message:
        `Lauf pausiert (Rate-Limit): ${outcome.reason} – Aussage unverändert, ` +
        "später erneut starten.",
    };
  }
  if (outcome.status === "exhausted") {
    await context.store.transaction((tx) => {
      tx.transitionClaim(claimId, {
        to: "pending_adjudication",
        actor: ACTOR_CHECK,
        reason: `Einschlägigkeitsprüfung endgültig gescheitert – eskaliert: ${outcome.lastError.message}`,
        routing: "escalated",
      });
    });
    bracket.escalated += 1;
    return {
      claimId,
      outcome: "escalated",
      message: `Adapter erschöpft – zur manuellen Überprüfung eskaliert (${outcome.lastError.message}).`,
    };
  }

  if (outcome.output.relevant === "yes") {
    // Positive outcome: deliberately no register write — the closed bracket
    // marks the sweep, the trace envelope holds the full judgment.
    bracket.kept += 1;
    return {
      claimId,
      outcome: "relevant",
      message: `Einschlägig für die neue Frage – Status bleibt. ${outcome.output.reasoning}`,
    };
  }
  const verdict = outcome.output.relevant === "no" ? "negativ" : "unsicher";
  await context.store.transaction((tx) => {
    tx.transitionClaim(claimId, {
      to: "pending_adjudication",
      actor: ACTOR_CHECK,
      reason: `Einschlägigkeit für die neue Recherchefrage ${verdict} bewertet: ${outcome.output.reasoning}`,
      routing: "negative_relevance",
    });
  });
  bracket.routed += 1;
  return {
    claimId,
    outcome: "pending_adjudication",
    message: `Einschlägigkeit ${verdict} – zur manuellen Überprüfung.`,
  };
}

/** Trailing pseudo-item: closes the bracket — but ONLY after a fully swept
 * run. The closed bracket is what marks the population as done (seq
 * boundary), so a pause or item error must leave the bracket open: the
 * state reads "interrupted" and the next run re-sweeps the remainder.
 * Claims judged positive before the interruption are then re-checked too —
 * the safe direction, mirroring the sample draw's crash semantics. */
async function closeBracket(
  context: RunContext,
  runId: string,
): Promise<RelevanceItemResult> {
  const { bracket } = context;
  if (bracket.pauseReason !== null || bracket.errors > 0) {
    const cause =
      bracket.pauseReason !== null
        ? `pausiert (${bracket.pauseReason})`
        : `${bracket.errors} Fehler`;
    return {
      outcome: "closed",
      message: `Lauf ${cause} – Klammer bleibt offen, nächster Lauf setzt fort.`,
    };
  }
  await context.store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "relevance_run_completed",
      reason:
        `Einschlägigkeitsprüfung abgeschlossen (Lauf ${runId}): ` +
        `${bracket.kept} einschlägig, ${bracket.routed} zur manuellen Überprüfung, ` +
        `${bracket.escalated} eskaliert, ${bracket.errors} Fehler.`,
      actor: ACTOR_RUN,
    });
  });
  return {
    outcome: "closed",
    message: `${bracket.kept} einschlägig, ${bracket.routed} zur manuellen Überprüfung, ${bracket.escalated} eskaliert.`,
  };
}
