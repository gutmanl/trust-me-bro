import { createProjectOrchestrator } from "../../adapters";
import type { Orchestrator } from "../../adapters";
import { loadAdapterConfig } from "../../identity";
import { evaluateAutoConfirmation } from "../../register";
import type { ClaimsRegister, RegisterStore, Source } from "../../register";
import { VerificationPreconditionError } from "../errors";
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

const SAMPLE_ITEM = "__stichprobe__";
const ACTOR_RUN = "system:verification" as const;
const ACTOR_STAGE1 = "system:existenzpruefung" as const;
const ACTOR_PRECHECK = "system:vorpruefung" as const;
const ACTOR_SAMPLE = "system:stichprobe" as const;

export interface VerificationDependencies {
  orchestrator?: Orchestrator;
  runner?: JobRunner;
  fetcher?: HttpFetcher;
}

export type VerificationItemOutcome =
  | "existenz_nicht_bestanden"
  | "automatisch_bestaetigt"
  | "zur_adjudikation"
  | "divergenz"
  | "eskaliert"
  | "pausiert"
  | "uebersprungen"
  | "stichprobe";

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
    deriveVerificationState(register, false).status === "unterbrochen";
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

  const runner = deps.runner ?? getGlobalJobRunner();
  const context: RunContext = {
    store,
    sourcesById: new Map(register.sources.map((source) => [source.id, source])),
    stage23: {
      orchestrator:
        deps.orchestrator ?? createProjectOrchestrator(register.config),
      primaryBackendId: register.config.backends.primary.cli,
      secondaryBackendId: register.config.backends.secondary?.cli,
      projectDir: store.projectDir,
      timeoutMs: loadAdapterConfig().timeoutMs,
      secondOpinion: register.config.second_opinion ?? DEFAULT_SECOND_OPINION,
      rubricVersion: register.config.rubric_version,
      ruleSet,
    },
    fetcher: deps.fetcher ?? nodeHttpFetcher,
    cache: new Map(),
    sampleRate: register.config.adjudication_sample_rate,
    totalEligible: eligible.length,
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
 * crash anywhere leaves started-without-completed (state "unterbrochen"). */
async function recordStartedOnce(
  context: RunContext,
  runId: string,
): Promise<void> {
  if (context.bracket.startedRecorded) {
    return;
  }
  await context.store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "verification_run_started",
      reason: `Prüflauf gestartet: ${context.totalEligible} Claim(s) (Lauf ${runId}).`,
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
      outcome: "uebersprungen",
      message: `Übersprungen – Lauf pausiert (${bracket.pauseReason}).`,
    };
  }

  let claim = (await context.store.read()).claims.find(
    (candidate) => candidate.id === claimId,
  );
  if (
    !claim ||
    (claim.status !== "erfasst" &&
      claim.status !== "existenzgeprueft" &&
      claim.status !== "nachpruefung_erforderlich")
  ) {
    return {
      claimId,
      outcome: "uebersprungen",
      message: "Übersprungen – Status hat sich seit Laufbeginn geändert.",
    };
  }

  // Nachprüfung (TMB-44): re-admit to the full cascade — the revised source
  // text can invalidate any stage's determination, so the claim re-enters
  // at erfasst and rides the existing pipeline unchanged.
  if (claim.status === "nachpruefung_erforderlich") {
    claim = await context.store.transaction((tx) => {
      tx.transitionClaim(claimId, {
        to: "erfasst",
        actor: ACTOR_STAGE1,
        reason:
          "Wiederaufnahme in die Prüfkaskade nach Bestandsrevision der Quelle(n).",
      });
      return tx.getClaim(claimId);
    });
  }

  // Stage 1 (deterministic, always re-checked for erfasst claims).
  if (claim.status === "erfasst") {
    const results = await checkClaimExistence(claim, context.sourcesById, {
      blobs: context.store.blobs(),
      fetcher: context.fetcher,
      cache: context.cache,
    });
    const failures = results.filter((result) => result.status !== "bestanden");
    const now = new Date().toISOString();
    claim = await context.store.transaction((tx) => {
      for (const result of results) {
        tx.setExistenceCheck(claimId, result.evidenceId, {
          status: result.status,
          at: now,
        });
      }
      tx.transitionClaim(claimId, {
        to: failures.length === 0 ? "existenzgeprueft" : "zur_adjudikation",
        actor: ACTOR_STAGE1,
        reason:
          failures.length === 0
            ? "Existenzprüfung bestanden: alle Fundstellen im eingefrorenen Bestand nachgewiesen."
            : `Existenzprüfung nicht bestanden: ${failures
                .map((failure) => failure.detail)
                .join(" ")}`,
        ...(failures.length > 0
          ? { routing: "existenz_nicht_bestanden" as const }
          : {}),
      });
      return tx.getClaim(claimId);
    });
    if (claim.status === "zur_adjudikation") {
      bracket.adjudicated += 1;
      return {
        claimId,
        outcome: "existenz_nicht_bestanden",
        message: `Existenzprüfung nicht bestanden (${failures.length} Fundstelle(n)) – zur Adjudikation.`,
      };
    }
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
      outcome: "pausiert",
      message:
        `Lauf pausiert (Rate-Limit): ${stage23.reason} – Claim unverändert, ` +
        "später erneut starten.",
    };
  }
  if (stage23.status === "exhausted") {
    await context.store.transaction((tx) => {
      tx.transitionClaim(claimId, {
        to: "zur_adjudikation",
        actor: ACTOR_PRECHECK,
        reason: `Prüfaufrufe endgültig gescheitert – eskaliert: ${stage23.message}`,
        routing: "eskaliert",
      });
    });
    bracket.escalated += 1;
    return {
      claimId,
      outcome: "eskaliert",
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
        to: "zur_adjudikation",
        actor: ACTOR_PRECHECK,
        reason:
          "Divergenz der Backend-Urteile – Relation bleibt bis zur " +
          "Adjudikation offen, beide Urteile sind sichtbar.",
        routing: "divergenz",
      });
      return "divergenz" as const;
    }
    tx.setSupportDegree(claimId, stage23.supportDegree);
    tx.setCalibrationResult(claimId, stage23.calibration.result);
    tx.transitionClaim(claimId, {
      to: "vorgeprueft",
      actor: ACTOR_PRECHECK,
      reason:
        `Stufen 2/3 abgeschlossen: Unterstützungsgrad ${stage23.supportDegree}, ` +
        `Rubrik ${stage23.calibration.result}` +
        (stage23.calibration.mechanical === "nicht_erfuellt"
          ? " (mechanisches Rubrik-Minimum verletzt)"
          : "") +
        `. ${stage23.calibration.reasoning}`,
    });
    const verdict = evaluateAutoConfirmation(tx.getClaim(claimId));
    if (verdict.ok) {
      tx.transitionClaim(claimId, {
        to: "automatisch_bestaetigt",
        actor: ACTOR_PRECHECK,
        reason:
          "Vorprüfung durchgehend positiv – automatisch bestätigt, " +
          "stichprobenweise nachprüfbar.",
      });
      return "automatisch_bestaetigt" as const;
    }
    tx.transitionClaim(claimId, {
      to: "zur_adjudikation",
      actor: ACTOR_PRECHECK,
      reason: `Nicht automatisch bestätigbar: ${verdict.reason}.`,
      routing: "negative_vorpruefung",
    });
    return "zur_adjudikation" as const;
  });

  if (outcome === "automatisch_bestaetigt") {
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
      outcome === "divergenz"
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
 * them up instead of letting them escape the Stichprobe. */
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
        to: "zur_adjudikation",
        actor: ACTOR_SAMPLE,
        reason: `Stichprobenkontrolle (Lauf ${runId}, Seed ${runId}, Rate ${sampleRate}).`,
        routing: "stichprobe",
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
    outcome: "stichprobe",
    message:
      drawn.length === 0
        ? `Keine Stichprobe gezogen (Rate ${sampleRate}).`
        : `Stichprobenkontrolle: ${drawn.length} Claim(s) zur Adjudikation gezogen.`,
  };
}
