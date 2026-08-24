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
   * ratified behavior).
   *
   * The transition table's gate NO LONGER enforces this scope — it was
   * widened for the reviewer-triggered re-verification and now admits any
   * machine routing (a rubric complaint, a divergence, a spot check). The
   * filter below is the ONLY thing keeping the correction path narrow;
   * lib/pipeline/sources/recheck.test.ts pins it. Removing the filter
   * because "the gate checks this anyway" would silently widen every
   * source revision to pull those claims out of adjudication too. */
  includeExistenceCheckRouting?: boolean;
}

/**
 * Pulls every claim whose settled determination rested on `sourceId`'s
 * evidence back into `recheck_required`, inside the CALLER's transaction —
 * shared by reviseSource (document changed) and correctSource (identity
 * changed): same consequence, different trigger. Returns the transitioned
 * claim ids.
 *
 * BRACKETS THE SWEEP (WR-03). Every path that pulls a claim back for a
 * re-check emits the `reverification_run_*` pair, because that bracket is
 * the boundary `ClaimMetricsRow.first_pass_adjudication_*` windows on, and
 * `reverification.reverified_claims` counts the ARCHIVE the re-check then
 * writes. Until this path emitted one, the two columns of the same RQ3
 * export answered "was this claim re-run?" differently on every project
 * that had ever revised or corrected a source: the archive said yes,
 * `first_pass_adjudication_count === adjudication_count` said no. The
 * register is append-only, so that discrepancy was not reconstructable
 * after the fact.
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
  const moved: string[] = [];
  for (const claim of affected) {
    tx.transitionClaim(claim.id, {
      to: "recheck_required",
      actor: options.actor,
      reason: options.reason,
      at: options.at,
    });
    moved.push(claim.id);
  }
  if (moved.length > 0) {
    // The payload is what actually moved, never the candidate list — the
    // bracket must describe the transitions made in THIS transaction.
    tx.recordReverificationRun({
      claim_ids: moved,
      actor: options.actor,
      started_reason: options.reason,
      completed_reason:
        `${moved.length} Aussage${moved.length === 1 ? "" : "n"} zur ` +
        "Nachprüfung vorgemerkt – die Prüfung selbst startet erst mit " +
        "dem nächsten Prüflauf.",
      at: options.at,
    });
  }
  return moved;
}
