import type { ActorId } from "../../identity";
import type { RegisterTransaction } from "../../register";
import { RECHECK_STATUSES } from "../verification/recheck-statuses";

export interface RecheckSweepOptions {
  actor: ActorId;
  at: string;
  reason: string;
  /** Also readmits claims currently in `pending_adjudication` whose LATEST
   * transition was routed there via `existence_check_failed` — opt-in
   * because only a source correction wants it: those claims are stuck on
   * the source's wrong identity, not on a human judgment. A plain document
   * revision leaves mid-human-workflow claims alone (reviseSource's
   * ratified behavior). The transition table's gate re-enforces the
   * routing scope at commit time. */
  includeExistenceCheckRouting?: boolean;
}

/**
 * Pulls every claim whose settled determination rested on `sourceId`'s
 * evidence back into `recheck_required`, inside the CALLER's transaction —
 * shared by reviseSource (document changed) and correctSource (identity
 * changed): same consequence, different trigger. Returns the transitioned
 * claim ids.
 */
export function sweepSourceRecheck(
  tx: RegisterTransaction,
  sourceId: string,
  options: RecheckSweepOptions,
): string[] {
  const affected = tx
    .listClaims()
    .filter(
      (claim) =>
        (RECHECK_STATUSES.has(claim.status) ||
          (options.includeExistenceCheckRouting === true &&
            claim.status === "pending_adjudication" &&
            claim.history.at(-1)?.routing === "existence_check_failed")) &&
        claim.evidence.some((evidence) => evidence.source_id === sourceId),
    );
  for (const claim of affected) {
    tx.transitionClaim(claim.id, {
      to: "recheck_required",
      actor: options.actor,
      reason: options.reason,
      at: options.at,
    });
  }
  return affected.map((claim) => claim.id);
}
