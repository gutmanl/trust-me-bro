import type { ClaimStatus } from "../../register";

/**
 * Claim statuses that new or changed evidence pulls into Nachprüfung
 * (TMB-44): exactly the settled machine/human determinations that were made
 * against the evidence as it stood. `captured` self-heals (stage 1 always
 * re-runs), the adjudication/repair statuses are mid human-workflow — pulling
 * them would yank a claim out from under the person working on it —, and
 * `discarded` stays terminal.
 *
 * Single-sourced here because three writers pull claims into recheck: the
 * source revision (sources/revise.ts), the incremental extraction
 * (extraction/apply-extraction-output.ts) and the reviewer's re-check
 * request (verification/request-recheck.ts).
 *
 * The transition table allows the `recheck_required` edge from these four
 * statuses unconditionally and from a FIFTH — `pending_adjudication` —
 * behind the `machineParkedInAdjudication` gate, which callers opt into
 * deliberately (today: sources/recheck.ts's `includeExistenceCheckRouting`).
 * `pending_adjudication` is deliberately NOT a member of this set: the set
 * is the source-status filter the three writers apply, and adding it would
 * change their behaviour rather than permit a new one. Set and table must
 * still be read together — the set is now the narrower of the two.
 */
export const RECHECK_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  "existence_checked",
  "prechecked",
  "auto_confirmed",
  "confirmed",
]);
