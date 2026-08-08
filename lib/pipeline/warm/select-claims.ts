import type { Claim, ProjectEvent } from "../../register";

/**
 * Population of the relevance check (TMB-43), derived from the REGISTER,
 * never from run memory — the same seq-boundary discipline as the sample
 * draw: adopted claims still in a positive settled status whose adoption
 * entry lies after the last closed relevance bracket have not been subject
 * to a completed sweep. A positive relevance outcome deliberately leaves no
 * register trace ("derive, don't store"), so the closed bracket is what
 * marks a claim as swept; a crash mid-run keeps the unswept remainder in
 * the population and the next run picks it up.
 *
 * `verworfen` adopted claims are excluded: a discard concerned the claim's
 * validity, not the research question — it is carried for the record (A6),
 * not re-litigated.
 */
export function pendingRelevancePopulation(
  claims: readonly Claim[],
  projectEvents: readonly ProjectEvent[],
): string[] {
  const lastCompletedSeq = projectEvents
    .filter((event) => event.event === "relevance_run_completed")
    .reduce((max, event) => Math.max(max, event.seq), 0);
  return claims
    .filter(
      (claim) =>
        claim.provenance.origin_project_id !== undefined &&
        (claim.status === "bestaetigt" ||
          claim.status === "automatisch_bestaetigt"),
    )
    .filter((claim) => (claim.history[0]?.seq ?? Infinity) > lastCompletedSeq)
    .map((claim) => claim.id);
}
