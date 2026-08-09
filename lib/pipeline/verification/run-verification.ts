import { createProjectOrchestrator, UnknownBackendError } from "../../adapters";
import type { Orchestrator } from "../../adapters";
import { loadAdapterConfig } from "../../identity";
import { evaluateAutoConfirmation } from "../../register";
import type { ClaimsRegister, RegisterStore, Source } from "../../register";
import { VerificationPreconditionError } from "../errors";
import {
  permissiveBackendPreflight,
  probeBackendUsable,
  withoutSecondaryBackend,
} from "../health";
import type { BackendPreflight } from "../health";
import { DEFAULT_SECOND_OPINION, requireProjectStore } from "../projects";
import { getGlobalJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import type { RunHandle } from "../runs/types";
import type { HttpFetcher } from "../sources/fetch-port";
import { nodeHttpFetcher } from "../sources/node-http-fetcher";
import { deriveVerificationState } from "./derive-state";
import type { VerificationState } from "./derive-state";
import { drawSample, pendingSamplePopulation } from "./sample-draw";
import { pickUnfinishedClaims } from "./select-claims";
import { checkClaimExistence } from "./stage1/existence-check";
import type { SourceCheckCache } from "./stage1/source-check";
import { loadRubricRuleSet } from "./rubric-rules";
import type { RubricRuleSet } from "./rubric-rules";
import { runAttributionAndRubric } from "./stage2/attribution-rubric";
import type {
  Stage23Dependencies,
  Stage23Ok,
} from "./stage2/attribution-rubric";

/**
 * The cascading verification run (epic TMB-4): one job-runner item per
 * claim, each claim passes stage 1 → 2 → 3 as far as its status allows,
 * plus a trailing pseudo-item for the sample draw. Persistence is per claim
 * — all facts and the earned transition(s) commit in ONE transaction, so an
 * abort at any point leaves every finished claim durable and every
 * unfinished claim untouched; resuming is simply starting a new run. All
 * network and CLI work happens OUTSIDE transactions (the project lock must
 * never span a slow call). A rate-limit pause latches: later claims are
 * skipped without register writes, the run closes its bracket normally.
 */

const SAMPLE_ITEM = "__spot_check__";
const ACTOR_RUN = "system:verification" as const;
const ACTOR_STAGE1 = "system:existence_check" as const;
const ACTOR_PRECHECK = "system:precheck" as const;
const ACTOR_SAMPLE = "system:spot_check" as const;

export interface VerificationDependencies {
  orchestrator?: Orchestrator;
  runner?: JobRunner;
  fetcher?: HttpFetcher;
  /** TMB-49 test seam; defaults to permissive when an orchestrator is
   * injected (a mock never talks to real CLIs), else to the real probe. */
  preflight?: BackendPreflight;
}

export type VerificationItemOutcome =
  | "existence_check_failed"
  | "auto_confirmed"
  | "pending_adjudication"
  | "divergence"
  | "escalated"
  | "paused"
  | "skipped"
  | "llm_locked"
  | "spot_check";

export interface VerificationItemResult {
  /** Absent for the sample-draw pseudo-item. */
  claimId?: string;
  outcome: VerificationItemOutcome;
  message: string;
}

interface RunContext {
  store: RegisterStore;
  sourcesById: ReadonlyMap<string, Source>;
  stage23: Omit<Stage23Dependencies, "projectDir"> & { projectDir: string };
  fetcher: HttpFetcher;
  cache: SourceCheckCache;
  sampleRate: number;
  totalEligible: number;
  /** TMB-49: non-null when the primary backend failed preflight — stage 1
   * still runs, the LLM stages are skipped per claim (claims stay
   * existence_checked and are swept up by a later run). */
  llmLockedHint: string | null;
  /** TMB-49: run-visible note when the secondary backend failed preflight
   * and the divergence rule is disabled for this run. */
  degradedNote: string | null;
  bracket: {
    startedRecorded: boolean;
    pauseReason: string | null;
    autoConfirmed: string[];
    adjudicated: number;
    escalated: number;
    errors: number;
  };
}

/** Starts the verification run on the in-process job runner. */
export async function startVerification(
  projectId: string,
  deps: VerificationDependencies = {},
): Promise<RunHandle<VerificationItemResult>> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  if (register.claims.length === 0) {
    throw new VerificationPreconditionError(
      "Vor der Prüfung müssen Claims extrahiert sein.",
    );
  }
  const eligible = pickUnfinishedClaims(register);
  // A dangling bracket (crash before the sample-draw item) is resumable
  // work even when no claim is open: the recovery run consists of the
  // sample-draw item alone and closes the bracket.
  const interrupted =
    deriveVerificationState(register, false).status === "interrupted";
  if (eligible.length === 0 && !interrupted) {
    throw new VerificationPreconditionError(
      "Kein Claim im Status erfasst oder existenzgeprüft – nichts zu prüfen.",
    );
  }
  let ruleSet: RubricRuleSet;
  try {
    ruleSet = loadRubricRuleSet(register.config.rubric_version);
  } catch (error) {
    throw new VerificationPreconditionError(
      `Rubrikversion "${register.config.rubric_version}" ist nicht prüfbar: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  // Preflight (TMB-49). Verification is deliberately NEVER hard-blocked:
  // stage 1 (deterministic existence check) must stay usable with the LLM
  // backends down. An unusable primary locks only the LLM stages per claim;
  // an unusable secondary disables the divergence rule for this run.
  const preflight =
    deps.preflight ??
    (deps.orchestrator ? permissiveBackendPreflight : probeBackendUsable);
  const primaryReady = await preflight(register.config.backends.primary.cli);
  const secondaryCli = register.config.backends.secondary?.cli;
  const secondaryReady =
    secondaryCli === undefined
      ? { usable: true as const }
      : await preflight(secondaryCli);
  const effectiveConfig = secondaryReady.usable
    ? register.config
    : withoutSecondaryBackend(register.config);

  let orchestrator: Orchestrator;
  try {
    orchestrator =
      deps.orchestrator ?? createProjectOrchestrator(effectiveConfig);
  } catch (error) {
    // A config referencing a backend this build refuses to construct (e.g.
    // the TMB-51 spike with its gate closed) is a config problem, not a
    // programming error — surface it as a precondition instead of a crash.
    if (error instanceof UnknownBackendError) {
      throw new VerificationPreconditionError(
        `Backend "${register.config.backends.primary.cli}" ist nicht verfügbar: ` +
          `${error.message} – Backend in den Einstellungen ändern.`,
        { cause: error },
      );
    }
    throw error;
  }

  const runner = deps.runner ?? getGlobalJobRunner();
  const context: RunContext = {
    store,
    sourcesById: new Map(register.sources.map((source) => [source.id, source])),
    stage23: {
      orchestrator,
      primaryBackendId: effectiveConfig.backends.primary.cli,
      secondaryBackendId: effectiveConfig.backends.secondary?.cli,
      projectDir: store.projectDir,
      timeoutMs: loadAdapterConfig().timeoutMs,
      secondOpinion: effectiveConfig.second_opinion ?? DEFAULT_SECOND_OPINION,
      rubricVersion: effectiveConfig.rubric_version,
      ruleSet,
    },
    fetcher: deps.fetcher ?? nodeHttpFetcher,
    cache: new Map(),
    sampleRate: register.config.adjudication_sample_rate,
    totalEligible: eligible.length,
    llmLockedHint: primaryReady.usable
      ? null
      : (primaryReady.hint ?? "Backend nicht einsatzbereit."),
    degradedNote: secondaryReady.usable
      ? null
      : `Divergenzregel deaktiviert – sekundäres Backend "${secondaryCli}" ` +
        `nicht einsatzbereit (${secondaryReady.hint ?? "unbekannt"}).`,
    bracket: {
      startedRecorded: false,
      pauseReason: null,
      autoConfirmed: [],
      adjudicated: 0,
      escalated: 0,
      errors: 0,
    },
  };

  return runner.submit(
    projectId,
    [...eligible.map((claim) => claim.id), SAMPLE_ITEM],
    (item) => item,
    async (item, { runId }) => {
      await recordStartedOnce(context, runId);
      if (item === SAMPLE_ITEM) {
        return drawSampleStep(context, runId);
      }
      try {
        return await processClaim(context, item);
      } catch (error) {
        context.bracket.errors += 1;
        throw error;
      }
    },
    { kind: "verification" },
  );
}

/** Register-derived verification state plus live-run knowledge, for UI/SSE.
 * Keyed by the routing project id (workspace directory name), which the run
 * was submitted under — NOT register.project.id: for a project imported
 * under a different directory name the two diverge (TMB-40). */
export function getVerificationState(
  projectId: string,
  register: ClaimsRegister,
  deps: { runner?: JobRunner } = {},
): VerificationState {
  const runner = deps.runner ?? getGlobalJobRunner();
  return deriveVerificationState(
    register,
    runner.isRunning(projectId, "verification"),
  );
}

/** The live (or latest) verification run handle, for the SSE stream. */
export function getVerificationRun(
  projectId: string,
  deps: { runner?: JobRunner } = {},
): RunHandle | undefined {
  return (deps.runner ?? getGlobalJobRunner()).currentRun(
    projectId,
    "verification",
  );
}

/** The run bracket opens in its own tiny transaction BEFORE any impure work
 * of the first item — every later write happens inside the bracket, and a
 * crash anywhere leaves started-without-completed (state "interrupted"). */
async function recordStartedOnce(
  context: RunContext,
  runId: string,
): Promise<void> {
  if (context.bracket.startedRecorded) {
    return;
  }
  const notes = [
    context.degradedNote,
    context.llmLockedHint === null
      ? null
      : `LLM-Prüfstufen gesperrt (Preflight): ${context.llmLockedHint}`,
  ].filter((note): note is string => note !== null);
  await context.store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "verification_run_started",
      reason:
        `Prüflauf gestartet: ${context.totalEligible} Claim(s) (Lauf ${runId}).` +
        (notes.length === 0 ? "" : ` ${notes.join(" ")}`),
      actor: ACTOR_RUN,
    });
  });
  context.bracket.startedRecorded = true;
}

async function processClaim(
  context: RunContext,
  claimId: string,
): Promise<VerificationItemResult> {
  const { bracket } = context;
  if (bracket.pauseReason !== null) {
    return {
      claimId,
      outcome: "skipped",
      message: `Übersprungen – Lauf pausiert (${bracket.pauseReason}).`,
    };
  }

  let claim = (await context.store.read()).claims.find(
    (candidate) => candidate.id === claimId,
  );
  if (
    !claim ||
    (claim.status !== "captured" &&
      claim.status !== "existence_checked" &&
      claim.status !== "recheck_required")
  ) {
    return {
      claimId,
      outcome: "skipped",
      message: "Übersprungen – Status hat sich seit Laufbeginn geändert.",
    };
  }

  // Recheck (TMB-44): re-admit to the full cascade — the revised source
  // text can invalidate any stage's determination, so the claim re-enters
  // at captured and rides the existing pipeline unchanged.
  if (claim.status === "recheck_required") {
    claim = await context.store.transaction((tx) => {
      tx.transitionClaim(claimId, {
        to: "captured",
        actor: ACTOR_STAGE1,
        reason:
          "Wiederaufnahme in die Prüfkaskade nach Bestandsrevision der Quelle(n).",
      });
      return tx.getClaim(claimId);
    });
  }

  // Stage 1 (deterministic, always re-checked for captured claims).
  if (claim.status === "captured") {
    const results = await checkClaimExistence(claim, context.sourcesById, {
      blobs: context.store.blobs(),
      fetcher: context.fetcher,
      cache: context.cache,
    });
    const failures = results.filter((result) => result.status !== "passed");
    const now = new Date().toISOString();
    claim = await context.store.transaction((tx) => {
      for (const result of results) {
        tx.setExistenceCheck(claimId, result.evidenceId, {
          status: result.status,
          at: now,
        });
      }
      tx.transitionClaim(claimId, {
        to:
          failures.length === 0 ? "existence_checked" : "pending_adjudication",
        actor: ACTOR_STAGE1,
        reason:
          failures.length === 0
            ? "Existenzprüfung bestanden: alle Fundstellen im eingefrorenen Bestand nachgewiesen."
            : `Existenzprüfung nicht bestanden: ${failures
                .map((failure) => failure.detail)
                .join(" ")}`,
        ...(failures.length > 0
          ? { routing: "existence_check_failed" as const }
          : {}),
      });
      return tx.getClaim(claimId);
    });
    if (claim.status === "pending_adjudication") {
      bracket.adjudicated += 1;
      return {
        claimId,
        outcome: "existence_check_failed",
        message: `Existenzprüfung nicht bestanden (${failures.length} Fundstelle(n)) – zur Adjudikation.`,
      };
    }
  }

  // LLM lock (TMB-49): stage 1 is done, the claim rests at existence_checked
  // untouched — a later run with a working backend sweeps it up via
  // pickUnfinishedClaims. Deliberately NOT an escalation: adjudication is
  // for content problems, a downed backend is an operations problem.
  if (context.llmLockedHint !== null) {
    return {
      claimId,
      outcome: "llm_locked",
      message:
        `LLM-Prüfstufen gesperrt (${context.llmLockedHint}) – ` +
        "Claim bleibt existenzgeprüft.",
    };
  }

  // Stages 2+3 (LLM, outside any transaction).
  const stage23 = await runAttributionAndRubric(
    claim,
    context.sourcesById,
    context.stage23,
  );
  if (stage23.status === "paused") {
    bracket.pauseReason = stage23.reason;
    return {
      claimId,
      outcome: "paused",
      message:
        `Lauf pausiert (Rate-Limit): ${stage23.reason} – Claim unverändert, ` +
        "später erneut starten.",
    };
  }
  if (stage23.status === "exhausted") {
    await context.store.transaction((tx) => {
      tx.transitionClaim(claimId, {
        to: "pending_adjudication",
        actor: ACTOR_PRECHECK,
        reason: `Prüfaufrufe endgültig gescheitert – eskaliert: ${stage23.message}`,
        routing: "escalated",
      });
    });
    bracket.escalated += 1;
    return {
      claimId,
      outcome: "escalated",
      message: `Adapter erschöpft – zur Adjudikation eskaliert (${stage23.message}).`,
    };
  }
  return applyPreCheckResult(context, claimId, stage23);
}

/** Persists judgments, resolved relations, support degree and calibration —
 * and the earned transition(s) — in ONE transaction per claim. */
async function applyPreCheckResult(
  context: RunContext,
  claimId: string,
  stage23: Stage23Ok,
): Promise<VerificationItemResult> {
  const { bracket } = context;
  const outcome = await context.store.transaction((tx) => {
    for (const entry of stage23.perEvidence) {
      for (const judgment of entry.newJudgments) {
        tx.appendJudgment(claimId, entry.evidenceId, judgment);
      }
      if (entry.resolvedRelation) {
        tx.setResolvedRelation(
          claimId,
          entry.evidenceId,
          entry.resolvedRelation,
        );
      }
    }
    if (stage23.supportDegree === null || stage23.calibration === null) {
      tx.transitionClaim(claimId, {
        to: "pending_adjudication",
        actor: ACTOR_PRECHECK,
        reason:
          "Divergenz der Backend-Urteile – Relation bleibt bis zur " +
          "Adjudikation offen, beide Urteile sind sichtbar.",
        routing: "divergence",
      });
      return "divergence" as const;
    }
    tx.setSupportDegree(claimId, stage23.supportDegree);
    tx.setCalibrationResult(claimId, stage23.calibration.result);
    tx.transitionClaim(claimId, {
      to: "prechecked",
      actor: ACTOR_PRECHECK,
      reason:
        `Stufen 2/3 abgeschlossen: Unterstützungsgrad ${stage23.supportDegree}, ` +
        `Rubrik ${stage23.calibration.result}` +
        (stage23.calibration.mechanical === "not_met"
          ? " (mechanisches Rubrik-Minimum verletzt)"
          : "") +
        `. ${stage23.calibration.reasoning}`,
    });
    const verdict = evaluateAutoConfirmation(tx.getClaim(claimId));
    if (verdict.ok) {
      tx.transitionClaim(claimId, {
        to: "auto_confirmed",
        actor: ACTOR_PRECHECK,
        reason:
          "Vorprüfung durchgehend positiv – automatisch bestätigt, " +
          "stichprobenweise nachprüfbar.",
      });
      return "auto_confirmed" as const;
    }
    tx.transitionClaim(claimId, {
      to: "pending_adjudication",
      actor: ACTOR_PRECHECK,
      reason: `Nicht automatisch bestätigbar: ${verdict.reason}.`,
      routing: "negative_precheck",
    });
    return "pending_adjudication" as const;
  });

  if (outcome === "auto_confirmed") {
    bracket.autoConfirmed.push(claimId);
    return {
      claimId,
      outcome,
      message: "Vorprüfung durchgehend positiv – automatisch bestätigt.",
    };
  }
  bracket.adjudicated += 1;
  return {
    claimId,
    outcome,
    message:
      outcome === "divergence"
        ? "Backend-Urteile divergieren – zur Adjudikation."
        : "Vorprüfung nicht durchgehend positiv – zur Adjudikation.",
  };
}

/** Trailing pseudo-item: draws the sample (seed = runId, documented in the
 * event) and closes the run bracket — in one transaction, so the drawn
 * transitions and the completion event are atomic. Runs even after a pause.
 * The population comes from the REGISTER (confirmations after the last
 * closed bracket), never from run memory: a crash between the last claim
 * and this item strands its confirmations, and the next run's draw sweeps
 * them up instead of letting them escape the spot check. */
async function drawSampleStep(
  context: RunContext,
  runId: string,
): Promise<VerificationItemResult> {
  const { bracket, sampleRate } = context;
  let drawn: string[] = [];
  await context.store.transaction((tx) => {
    drawn = drawSample(
      pendingSamplePopulation(tx.listClaims(), tx.listProjectEvents()),
      sampleRate,
      runId,
    );
    for (const claimId of drawn) {
      tx.transitionClaim(claimId, {
        to: "pending_adjudication",
        actor: ACTOR_SAMPLE,
        reason: `Stichprobenkontrolle (Lauf ${runId}, Seed ${runId}, Rate ${sampleRate}).`,
        routing: "spot_check",
      });
    }
    const summary =
      `${bracket.autoConfirmed.length} automatisch bestätigt, ` +
      `${bracket.adjudicated} zur Adjudikation, ${bracket.escalated} eskaliert, ` +
      `${bracket.errors} Fehler, ${drawn.length} Stichprobe(n) (Rate ${sampleRate}, Seed ${runId}).`;
    tx.recordProjectEvent({
      event: "verification_run_completed",
      reason:
        bracket.pauseReason === null
          ? `Prüflauf abgeschlossen (Lauf ${runId}): ${summary}`
          : `Prüflauf pausiert (Rate-Limit, Lauf ${runId}): ${summary} Grund: ${bracket.pauseReason}`,
      actor: ACTOR_RUN,
    });
  });
  return {
    outcome: "spot_check",
    message:
      drawn.length === 0
        ? `Keine Stichprobe gezogen (Rate ${sampleRate}).`
        : `Stichprobenkontrolle: ${drawn.length} Claim(s) zur Adjudikation gezogen.`,
  };
}
