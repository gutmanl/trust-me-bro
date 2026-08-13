import type { ClaimsRegister } from "../../register";
import { deriveRunBracket } from "../runs/derive-bracket";
import { pickUnfinishedClaims } from "./select-claims";

/**
 * Verification state derived purely from the register (plus the volatile
 * "a live run exists" flag). Unlike extraction, a verification run persists
 * per claim, so "work remaining" is recomputed from CURRENT claim statuses —
 * never from event counts. Every non-running state is safely restartable:
 * a new run simply picks up the claims still in captured/existence_checked.
 */

export type VerificationStatus =
  "not_started" | "running" | "interrupted" | "halted" | "completed";

export interface VerificationState {
  status: VerificationStatus;
  startedAt?: string;
  completedAt?: string;
  /** Reason of the last verification_run_completed event. */
  reason?: string;
  /** Claims still in captured/existence_checked. */
  openClaims: number;
  totalClaims: number;
}

export function deriveVerificationState(
  register: ClaimsRegister,
  hasActiveRun: boolean,
): VerificationState {
  const openClaims = pickUnfinishedClaims(register).length;
  const totalClaims = register.claims.length;
  const bracket = deriveRunBracket(
    register.project_events,
    "verification_run_started",
    "verification_run_completed",
    hasActiveRun,
  );

  switch (bracket.phase) {
    case "running":
      return {
        status: "running",
        startedAt: bracket.startedAt,
        openClaims,
        totalClaims,
      };
    case "interrupted":
      // Opening bracket without a close: the process was interrupted. Every
      // fully checked claim is already committed individually — restarting is
      // safe and only checks the remainder.
      return {
        status: "interrupted",
        startedAt: bracket.startedAt,
        openClaims,
        totalClaims,
      };
    case "closed":
      return {
        // halted = ended cleanly, but claims remain open (rate-limit pause or
        // item error); derived structurally from the claim statuses, not from
        // the event text.
        status: openClaims > 0 ? "halted" : "completed",
        startedAt: bracket.startedAt,
        completedAt: bracket.completedAt,
        reason: bracket.reason,
        openClaims,
        totalClaims,
      };
    case "not_started":
      return { status: "not_started", openClaims, totalClaims };
  }
}
