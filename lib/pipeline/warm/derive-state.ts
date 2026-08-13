import type { ClaimsRegister } from "../../register";
import { deriveRunBracket } from "../runs/derive-bracket";
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

  const bracket = deriveRunBracket(
    register.project_events,
    "relevance_run_started",
    "relevance_run_completed",
    hasActiveRun,
  );

  switch (bracket.phase) {
    case "running":
      return {
        status: "running",
        startedAt: bracket.startedAt,
        pendingClaims,
        adoptedClaims,
      };
    case "interrupted":
      return {
        status: "interrupted",
        startedAt: bracket.startedAt,
        pendingClaims,
        adoptedClaims,
      };
    case "closed":
      return {
        status: pendingClaims > 0 ? "halted" : "completed",
        startedAt: bracket.startedAt,
        completedAt: bracket.completedAt,
        reason: bracket.reason,
        pendingClaims,
        adoptedClaims,
      };
    case "not_started":
      return { status: "not_started", pendingClaims, adoptedClaims };
  }
}
