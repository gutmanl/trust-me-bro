import type { ClaimsRegister, HistoryEntry, ProjectEvent } from "../register";

/**
 * The mixed project chain for the history view (TMB-38): claim histories
 * and project events merged into one chronological sequence ordered by
 * `seq` — exactly the global, gapless sequence the hash chain links. Pure
 * derivation; the optional claim filter narrows to one claim's history
 * (project events are omitted there, matching the claim-centric view).
 */

export type TimelineEntry =
  | { kind: "claim"; claimId: string; entry: HistoryEntry }
  | { kind: "project"; entry: ProjectEvent };

export function buildTimeline(
  register: ClaimsRegister,
  claimFilter?: string,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const claim of register.claims) {
    if (claimFilter && claim.id !== claimFilter) {
      continue;
    }
    for (const entry of claim.history) {
      entries.push({ kind: "claim", claimId: claim.id, entry });
    }
  }
  if (!claimFilter) {
    for (const entry of register.project_events) {
      entries.push({ kind: "project", entry });
    }
  }
  return entries.sort((a, b) => a.entry.seq - b.entry.seq);
}
