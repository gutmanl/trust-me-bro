import type { Claim } from "../../register";
import { allExistenceChecksPassed } from "../../register";
import { countRepairCycles } from "../../register";

/**
 * Which re-entry edge a just-revised (`revised`) claim takes (TMB-37,
 * "nur die betroffenen Prüfstufen"). The rule is mechanical, no text
 * heuristic: a repair only ever changes the wording, never the frozen
 * evidence, so the existing existence checks stay valid — exactly what the
 * `allExistenceChecksPassed` gate verifies. Stage 2/3 always re-run because
 * the next verification pass judges the NEW wording against the excerpts.
 *
 * - cycle budget exhausted → `pending_adjudication` (escalation to the
 *   reviewer instead of endless iteration; routing "escalated")
 * - all existence checks passed (evidence untouched) → `existence_checked`
 *   (skip stage 1: mere weakening/reformulation)
 * - otherwise (new/failed evidence) → `captured` (full cascade)
 *
 * The claim passed in already carries the current cycle's `revised`
 * transition; the count therefore includes this cycle.
 */
export type ReEntryTarget =
  "captured" | "existence_checked" | "pending_adjudication";

export interface ReEntryDecision {
  target: ReEntryTarget;
  reason: string;
}

export function decideReEntry(
  claim: Claim,
  maxCycles: number,
): ReEntryDecision {
  const cycle = countRepairCycles(claim);
  if (cycle > maxCycles) {
    return {
      target: "pending_adjudication",
      reason:
        `Eskaliert nach ${cycle - 1} erfolglosen Reparaturzyklen ` +
        `(Limit ${maxCycles}): der Prüfer entscheidet direkt.`,
    };
  }
  if (allExistenceChecksPassed(claim).ok) {
    return {
      target: "existence_checked",
      reason:
        "Belege unverändert und bereits nachgewiesen – Stufe 1 " +
        "übersprungen, Belegprüfung und Bewertung prüfen die Neufassung.",
    };
  }
  return {
    target: "captured",
    reason:
      "Wiedereintritt in die vollständige Prüfung (Belege nicht " +
      "vollständig nachgewiesen).",
  };
}
