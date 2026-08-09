import type { ClaimsRegister } from "../../register";
import { pendingRelevancePopulation } from "./select-claims";

/**
 * Relevance-check state derived purely from the register (plus the volatile
 * "a live run exists" flag), mirroring the verification derivation: the
 * bracket events say whether a run started/closed, the pending population
 * says what work remains. `not_applicable` = the project adopted nothing,
 * so the relevance check does not apply (cold run).
 */

export type RelevanceStatus =
  | "not_applicable"
  | "not_started"
  | "running"
  | "interrupted"
  | "halted"
  | "completed";

export interface RelevanceState {
  status: RelevanceStatus;
  startedAt?: string;
  completedAt?: string;
  /** Reason of the last relevance_run_completed event. */
  reason?: string;
  /** Adopted claims still awaiting a completed relevance sweep. */
  pendingClaims: number;
  /** All adopted claims of the project (any status). */
  adoptedClaims: number;
}

export function deriveRelevanceState(
  register: ClaimsRegister,
  hasActiveRun: boolean,
): RelevanceState {
  const adoptedClaims = register.claims.filter(
    (claim) => claim.provenance.origin_project_id !== undefined,
  ).length;
  const pendingClaims = pendingRelevancePopulation(
    register.claims,
    register.project_events,
  ).length;
  if (adoptedClaims === 0) {
    return { status: "not_applicable", pendingClaims, adoptedClaims };
  }

  const started = register.project_events.filter(
    (event) => event.event === "relevance_run_started",
  );
  const completed = register.project_events.filter(
    (event) => event.event === "relevance_run_completed",
  );
  const lastStarted = started.at(-1);
  const lastCompleted = completed.at(-1);

  if (hasActiveRun) {
    return {
      status: "running",
      startedAt: lastStarted?.at,
      pendingClaims,
      adoptedClaims,
    };
  }
  if (lastStarted && (!lastCompleted || lastCompleted.seq < lastStarted.seq)) {
    return {
      status: "interrupted",
      startedAt: lastStarted.at,
      pendingClaims,
      adoptedClaims,
    };
  }
  if (lastCompleted) {
    return {
      status: pendingClaims > 0 ? "halted" : "completed",
      startedAt: lastStarted?.at,
      completedAt: lastCompleted.at,
      reason: lastCompleted.reason,
      pendingClaims,
      adoptedClaims,
    };
  }
  return { status: "not_started", pendingClaims, adoptedClaims };
}
