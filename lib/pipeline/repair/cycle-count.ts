import type { Claim } from "../../register";

/**
 * Repair cycles of a claim, derived from the history instead of a stored
 * counter (a second source of truth could desync from the chain it
 * summarizes — same discipline as pickUnfinishedClaims and the sample
 * population). One cycle = one accepted revision (`beanstandet →
 * ueberarbeitet`).
 */
export function countRepairCycles(claim: Claim): number {
  return claim.history.filter(
    (entry) =>
      entry.from_status === "beanstandet" &&
      entry.to_status === "ueberarbeitet",
  ).length;
}
