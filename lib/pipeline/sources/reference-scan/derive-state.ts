import type { ClaimsRegister } from "../../../register";

/**
 * Reference-scan state derived purely from the register (plus the volatile
 * "a live run exists" flag), mirroring extraction/derive-state.ts: the
 * reference_scan_started/completed events bracket a run, and — because the
 * pointer is written in the SAME transaction as the completion event
 * (run-reference-scan.ts's atomicity) — a dangling open bracket
 * unambiguously means the process was interrupted before anything was
 * written, exactly like extraction. Unlike extraction there is no "failed"
 * status: a reference scan never fails outright, at worst it degrades to
 * the regex-only channel (see run-reference-scan.ts's doc comment) — that
 * degradation still ends in a completed scan.
 */

export type ReferenceScanStatus =
  "not_started" | "running" | "interrupted" | "completed";

export interface ReferenceScanState {
  status: ReferenceScanStatus;
  startedAt?: string;
  completedAt?: string;
  /** Reason of the last reference_scan_completed event — carries the
   * method (regex vs. regex+llm) and any degradation note. */
  reason?: string;
  /** candidate_count of the current pointer, 0 before any scan. */
  candidateCount: number;
}

export function deriveReferenceScanState(
  register: ClaimsRegister,
  hasActiveRun: boolean,
): ReferenceScanState {
  const started = register.project_events.filter(
    (event) => event.event === "reference_scan_started",
  );
  const completed = register.project_events.filter(
    (event) => event.event === "reference_scan_completed",
  );
  const lastStarted = started.at(-1);
  const lastCompleted = completed.at(-1);
  const candidateCount = register.project.reference_scan?.candidate_count ?? 0;

  if (hasActiveRun) {
    return { status: "running", startedAt: lastStarted?.at, candidateCount };
  }
  if (lastStarted && (!lastCompleted || lastCompleted.seq < lastStarted.seq)) {
    return {
      status: "interrupted",
      startedAt: lastStarted.at,
      candidateCount,
    };
  }
  if (lastCompleted) {
    return {
      status: "completed",
      startedAt: lastStarted?.at,
      completedAt: lastCompleted.at,
      reason: lastCompleted.reason,
      candidateCount,
    };
  }
  return { status: "not_started", candidateCount };
}
