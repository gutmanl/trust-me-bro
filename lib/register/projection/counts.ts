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
