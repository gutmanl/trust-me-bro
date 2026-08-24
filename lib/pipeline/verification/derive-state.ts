import { claimIdsRecheckedInLatestRun } from "../../register";
import type { ClaimsRegister } from "../../register";
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
  /**
   * Whether a reviewer asked for a re-verification between the previous run
   * and the latest one (D-16) — i.e. whether the run this state describes
   * was carrying re-checks rather than first passes.
   *
   * ADDITIVE ONLY. It is what makes the bar's one-time post-run summary
   * transient: the summary is present for the most recently completed run
   * that was preceded by a re-run bracket and gone as soon as any later run
   * completes, which is exactly this flag going false again. Without it the
   * only alternative would be a durable "we once re-ran" marker, and D-16
   * rejected standing furniture.
   *
   * It is deliberately NOT wired into the interrupted-detection branch. The
   * `reverification_run_*` pair is a DISTINCT bracket that opens and closes
   * inside one transaction; folding it into the two literal
   * `verification_run_*` filters above would let a completed sweep read as
   * an interrupted verification run, which is the RERUN-06 regression those
   * two filters are pinned byte-for-byte against.
   */
  precededByRecheck: boolean;
}

/**
 * Did a re-verification get requested in the window that ends at the latest
 * verification run?
 *
 * The window itself lives in `claimIdsRecheckedInLatestRun`
 * (`lib/register/projection/metrics.ts`) and this is the boolean view of
 * it. Single-sourced deliberately (WR-02): this flag GATES the workbench's
 * post-run summary and the metrics projection supplies the two numbers
 * INSIDE that summary. While the window existed twice, the gate and the
 * numbers were free to disagree about which run the sentence describes —
 * and they did, because the numbers were not windowed at all.
 */
function recheckPrecededLatestRun(register: ClaimsRegister): boolean {
  return claimIdsRecheckedInLatestRun(register) !== null;
}

export function deriveVerificationState(
  register: ClaimsRegister,
  hasActiveRun: boolean,
): VerificationState {
  const started = register.project_events.filter(
    (event) => event.event === "verification_run_started",
  );
  const completed = register.project_events.filter(
    (event) => event.event === "verification_run_completed",
  );
  const lastStarted = started.at(-1);
  const lastCompleted = completed.at(-1);
  const openClaims = pickUnfinishedClaims(register).length;
  const totalClaims = register.claims.length;
  const precededByRecheck = recheckPrecededLatestRun(register);

  if (hasActiveRun) {
    return {
      status: "running",
      startedAt: lastStarted?.at,
      openClaims,
      totalClaims,
      precededByRecheck,
    };
  }
  if (lastStarted && (!lastCompleted || lastCompleted.seq < lastStarted.seq)) {
    // Opening bracket without a close: the process was interrupted. Every
    // fully checked claim is already committed individually — restarting is
    // safe and only checks the remainder.
    return {
      status: "interrupted",
      startedAt: lastStarted.at,
      openClaims,
      totalClaims,
      precededByRecheck,
    };
  }
  if (lastCompleted) {
    return {
      // halted = ended cleanly, but claims remain open (rate-limit pause or
      // item error); derived structurally from the claim statuses, not from
      // the event text.
      status: openClaims > 0 ? "halted" : "completed",
      startedAt: lastStarted?.at,
      completedAt: lastCompleted.at,
      reason: lastCompleted.reason,
      openClaims,
      totalClaims,
      precededByRecheck,
    };
  }
  return {
    status: "not_started",
    openClaims,
    totalClaims,
    precededByRecheck,
  };
}
