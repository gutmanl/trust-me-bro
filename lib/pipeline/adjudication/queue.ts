import type { Claim, ClaimsRegister, RoutingReason } from "../../register";

/**
 * The adjudication queue (TMB-36): every claim awaiting adjudication with
 * its structured routing reason — read from the history entry that put it
 * there, never parsed out of free text. Pure derivation over the register;
 * computed server-side, filtered/sorted client-side on the serialized
 * entries.
 */

export interface QueueEntry {
  claim: Claim;
  /** Structured routing reason; null for entries from before the routing
   * extension or for creation-time atomicity rejections ("ohne Zuordnung"). */
  routing: RoutingReason | null;
  /** Timestamp of the transition into zur_adjudikation (queue age). */
  queuedAt: string;
}

export function buildAdjudicationQueue(register: ClaimsRegister): QueueEntry[] {
  return register.claims
    .filter((claim) => claim.status === "zur_adjudikation")
    .map((claim) => {
      const routingEntry = claim.history.findLast(
        (entry) => entry.to_status === "zur_adjudikation",
      );
      return {
        claim,
        routing: routingEntry?.routing ?? null,
        queuedAt: routingEntry?.at ?? claim.history[0].at,
      };
    })
    .sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1));
}

/** Filter of the queue UI: a concrete routing reason, "ohne_zuordnung" for
 * entries without one, or "alle". */
export type QueueRoutingFilter = "alle" | "ohne_zuordnung" | RoutingReason;

export function filterQueue(
  entries: QueueEntry[],
  filter: QueueRoutingFilter,
): QueueEntry[] {
  if (filter === "alle") {
    return entries;
  }
  if (filter === "ohne_zuordnung") {
    return entries.filter((entry) => entry.routing === null);
  }
  return entries.filter((entry) => entry.routing === filter);
}

/**
 * Sort of the queue UI. `routingOrder` is the display order (the label
 * module's concern) and arrives as a parameter: importing the enum at
 * runtime would drag the register barrel — and node:fs — into the client
 * bundle this pure module is deliberately safe for.
 */
export function sortQueue(
  entries: QueueEntry[],
  by: "wartezeit" | "routing",
  routingOrder: readonly RoutingReason[],
): QueueEntry[] {
  return [...entries].sort((a, b) => {
    if (by === "routing") {
      const ra = a.routing
        ? routingOrder.indexOf(a.routing)
        : routingOrder.length;
      const rb = b.routing
        ? routingOrder.indexOf(b.routing)
        : routingOrder.length;
      if (ra !== rb) {
        return ra - rb;
      }
    }
    return a.queuedAt < b.queuedAt ? -1 : 1;
  });
}
