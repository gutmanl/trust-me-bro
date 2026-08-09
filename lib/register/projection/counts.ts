import type { Claim } from "../schema/claim";
import { ClaimStatus } from "../schema/enums";

/**
 * Claim counts per status for the project overview (TMB-21). Every status of
 * the model appears in the result, zero-valued when absent, so consumers can
 * render a complete status summary without knowing the enum themselves.
 */
export function countClaimsByStatus(
  claims: readonly Claim[],
): Record<ClaimStatus, number> {
  const counts = Object.fromEntries(
    ClaimStatus.options.map((status) => [status, 0]),
  ) as Record<ClaimStatus, number>;
  for (const claim of claims) {
    counts[claim.status] += 1;
  }
  return counts;
}

/**
 * Repair cycles of a claim, derived from the history instead of a stored
 * counter (a second source of truth could desync from the chain it
 * summarizes — same discipline as the sample population and the TMB-45
 * metrics). One cycle = one accepted revision (`contested →
 * revised`). Relocated here from the repair pipeline with TMB-45: it
 * is a pure history derivation shared by re-entry and metrics.
 */
export function countRepairCycles(claim: Claim): number {
  return claim.history.filter(
    (entry) =>
      entry.from_status === "contested" && entry.to_status === "revised",
  ).length;
}
