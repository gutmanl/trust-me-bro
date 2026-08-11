import type { ClaimStatus } from "../../register";

/**
 * Claim statuses that new or changed evidence pulls into Nachprüfung
 * (TMB-44): exactly the settled machine/human determinations that were made
 * against the evidence as it stood. `captured` self-heals (stage 1 always
 * re-runs), the adjudication/repair statuses are mid human-workflow — pulling
 * them would yank a claim out from under the person working on it —, and
 * `discarded` stays terminal.
 *
 * Single-sourced here because two writers pull claims into recheck: the
 * source revision (sources/revise.ts) and the incremental extraction
 * (extraction/apply-extraction-output.ts). The transition table allows the
 * `recheck_required` edge from exactly these four statuses, so this set and
 * the table must be read together.
 */
export const RECHECK_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  "existence_checked",
  "prechecked",
  "auto_confirmed",
  "confirmed",
]);
