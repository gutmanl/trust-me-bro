import type { Claim, ClaimsRegister, RoutingReason } from "../../register";

/**
 * The adjudication queue (TMB-36): every claim awaiting adjudication with
 * its structured routing reason — read from the history entry that put it
 * there, never parsed out of free text. Pure derivation over the register,
 * computed server-side.
 */

export interface QueueEntry {
  claim: Claim;
  /** Structured routing reason; null for entries from before the routing
   * extension or for creation-time atomicity rejections ("ohne Zuordnung"). */
  routing: RoutingReason | null;
  /** Timestamp of the transition into pending_adjudication (queue age). */
  queuedAt: string;
}

export function buildAdjudicationQueue(register: ClaimsRegister): QueueEntry[] {
  return register.claims
    .filter((claim) => claim.status === "pending_adjudication")
    .map((claim) => {
      const routingEntry = claim.history.findLast(
        (entry) => entry.to_status === "pending_adjudication",
      );
      return {
        claim,
        routing: routingEntry?.routing ?? null,
        queuedAt: routingEntry?.at ?? claim.history[0].at,
      };
    })
    .sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1));
}
