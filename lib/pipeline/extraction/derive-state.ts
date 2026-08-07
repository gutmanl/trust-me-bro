import type { ClaimsRegister } from "../../register";

/**
 * Extraction state derived purely from the register (plus the volatile
 * "a live run exists" flag): the two batch events bracket a run, and the
 * bracket invariant — claims land in the SAME transaction as
 * batch_run_completed — makes every state distinguishable after a crash
 * without any separate run store.
 */

export type ExtractionStatus =
  | "nicht_gestartet"
  | "laeuft"
  | "unterbrochen"
  | "fehlgeschlagen"
  | "abgeschlossen";

export interface ExtractionState {
  status: ExtractionStatus;
  startedAt?: string;
  completedAt?: string;
  /** Reason of the last batch_run_completed event (success or failure). */
  reason?: string;
  totalClaims: number;
}

export function deriveExtractionState(
  register: ClaimsRegister,
  hasActiveRun: boolean,
): ExtractionState {
  const started = register.project_events.filter(
    (event) => event.event === "batch_run_started",
  );
  const completed = register.project_events.filter(
    (event) => event.event === "batch_run_completed",
  );
  const lastStarted = started.at(-1);
  const lastCompleted = completed.at(-1);
  const totalClaims = register.claims.length;

  if (hasActiveRun) {
    return { status: "laeuft", startedAt: lastStarted?.at, totalClaims };
  }
  if (lastStarted && (!lastCompleted || lastCompleted.seq < lastStarted.seq)) {
    // Startklammer ohne Abschluss: Prozess wurde unterbrochen; per Invariante
    // wurden dabei keine Claims geschrieben — erneut starten ist sicher.
    return { status: "unterbrochen", startedAt: lastStarted.at, totalClaims };
  }
  if (totalClaims > 0) {
    return {
      status: "abgeschlossen",
      startedAt: lastStarted?.at,
      completedAt: lastCompleted?.at,
      reason: lastCompleted?.reason,
      totalClaims,
    };
  }
  if (lastCompleted) {
    return {
      status: "fehlgeschlagen",
      startedAt: lastStarted?.at,
      completedAt: lastCompleted.at,
      reason: lastCompleted.reason,
      totalClaims,
    };
  }
  return { status: "nicht_gestartet", totalClaims };
}
