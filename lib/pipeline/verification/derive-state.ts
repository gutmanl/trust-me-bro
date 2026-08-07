import type { ClaimsRegister } from "../../register";
import { pickUnfinishedClaims } from "./select-claims";

/**
 * Verification state derived purely from the register (plus the volatile
 * "a live run exists" flag). Unlike extraction, a verification run persists
 * per claim, so "work remaining" is recomputed from CURRENT claim statuses —
 * never from event counts. Every non-laufend state is safely restartable:
 * a new run simply picks up the claims still in erfasst/existenzgeprueft.
 */

export type VerificationStatus =
  | "nicht_gestartet"
  | "laeuft"
  | "unterbrochen"
  | "angehalten"
  | "abgeschlossen";

export interface VerificationState {
  status: VerificationStatus;
  startedAt?: string;
  completedAt?: string;
  /** Reason of the last verification_run_completed event. */
  reason?: string;
  /** Claims still in erfasst/existenzgeprueft. */
  openClaims: number;
  totalClaims: number;
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

  if (hasActiveRun) {
    return {
      status: "laeuft",
      startedAt: lastStarted?.at,
      openClaims,
      totalClaims,
    };
  }
  if (lastStarted && (!lastCompleted || lastCompleted.seq < lastStarted.seq)) {
    // Startklammer ohne Abschluss: Prozess wurde unterbrochen. Jeder fertig
    // geprüfte Claim ist bereits einzeln committet — erneut starten ist
    // sicher und prüft nur den Rest.
    return {
      status: "unterbrochen",
      startedAt: lastStarted.at,
      openClaims,
      totalClaims,
    };
  }
  if (lastCompleted) {
    return {
      // angehalten = ordentlich beendet, aber Claims verbleiben offen
      // (Rate-Limit-Pause oder Item-Fehler); strukturell aus den
      // Claim-Statuus abgeleitet, nicht aus dem Ereignistext.
      status: openClaims > 0 ? "angehalten" : "abgeschlossen",
      startedAt: lastStarted?.at,
      completedAt: lastCompleted.at,
      reason: lastCompleted.reason,
      openClaims,
      totalClaims,
    };
  }
  return { status: "nicht_gestartet", openClaims, totalClaims };
}
