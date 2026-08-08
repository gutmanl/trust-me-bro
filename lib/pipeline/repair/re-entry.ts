import type { Claim } from "../../register";
import { allExistenceChecksPassed } from "../../register";
import { countRepairCycles } from "./cycle-count";

/**
 * Which re-entry edge a just-revised (`ueberarbeitet`) claim takes (TMB-37,
 * "nur die betroffenen Prüfstufen"). The rule is mechanical, no text
 * heuristic: a repair only ever changes the wording, never the frozen
 * evidence, so the existing existence checks stay valid — exactly what the
 * `allExistenceChecksPassed` gate verifies. Stage 2/3 always re-run because
 * the next verification pass judges the NEW wording against the excerpts.
 *
 * - cycle budget exhausted → `zur_adjudikation` (escalation to the reviewer
 *   instead of endless iteration; routing "eskaliert")
 * - all existence checks passed (evidence untouched) → `existenzgeprueft`
 *   (skip stage 1: mere Abschwächung/Neuformulierung)
 * - otherwise (new/failed Fundstelle) → `erfasst` (full cascade)
 *
 * The claim passed in already carries the current cycle's `ueberarbeitet`
 * transition; the count therefore includes this cycle.
 */
export type ReEntryTarget = "erfasst" | "existenzgeprueft" | "zur_adjudikation";

export interface ReEntryDecision {
  target: ReEntryTarget;
  reason: string;
}

export function decideReEntry(claim: Claim, maxCycles: number): ReEntryDecision {
  const cycle = countRepairCycles(claim);
  if (cycle > maxCycles) {
    return {
      target: "zur_adjudikation",
      reason:
        `Eskaliert nach ${cycle - 1} erfolglosen Reparaturzyklen ` +
        `(Limit ${maxCycles}): der Prüfer entscheidet direkt.`,
    };
  }
  if (allExistenceChecksPassed(claim).ok) {
    return {
      target: "existenzgeprueft",
      reason:
        "Fundstellen unverändert und bereits nachgewiesen – Stufe 1 " +
        "übersprungen, Attribution und Kalibrierung prüfen die Neufassung.",
    };
  }
  return {
    target: "erfasst",
    reason:
      "Wiedereintritt in die volle Prüfkaskade (Fundstellen nicht " +
      "vollständig nachgewiesen).",
  };
}
