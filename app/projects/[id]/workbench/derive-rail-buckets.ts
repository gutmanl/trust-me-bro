import type {
  RepairActionVM,
  ReviewCandidate,
  SourceWorkItemVM,
} from "@/lib/pipeline";

/**
 * The unified source list's row buckets, derived as a pure function so the
 * bucketing rules are testable without rendering the rail (the register-side
 * analogues — deriveSourceLifecycles, deriveOpenRepairActions — set the
 * precedent).
 *
 * The rules: a candidate's capture state IS its work item (same id),
 * rendered on the candidate row — so those work items must not ALSO render
 * as standalone rows; only orphans (candidate rescanned away) keep their own
 * row. Correction items render as state on their target source's row for the
 * same reason (source correction).
 */
export interface RailBuckets {
  /** Reference candidates not yet captured, in scan order. */
  openCandidates: ReviewCandidate[];
  /** Live/failed capture state per open candidate (same work-item id). */
  workItemByCandidate: Map<string, SourceWorkItemVM>;
  /** ALL correction items per source, not just the latest: a fresh
   * correction may be running while an earlier attempt's open failure is
   * still on the books — the row must show both (live progress AND every
   * failure's retry/dismiss), or the loser of a per-source collision would
   * render nowhere. Auto-repair items targeting a source render there too. */
  correctionsBySource: Map<string, SourceWorkItemVM[]>;
  /** Work items with a row of their own: manual captures, and
   * reference-import/auto-repair items whose candidate no longer exists. */
  standaloneWorkItems: SourceWorkItemVM[];
  /** Open repair suggestion per failed capture work item. */
  suggestionByWorkItem: Map<string, RepairActionVM>;
  /** Open repair suggestion per captured source. */
  suggestionBySource: Map<string, RepairActionVM>;
  /** Open candidates currently selected for capture. */
  readyCandidateCount: number;
}

export function deriveRailBuckets({
  candidates,
  workItems,
  repairSuggestions,
}: {
  /** The scan's reviewed candidates; undefined before a briefing exists. */
  candidates: ReviewCandidate[] | undefined;
  workItems: SourceWorkItemVM[];
  repairSuggestions: RepairActionVM[];
}): RailBuckets {
  const openCandidates =
    candidates?.filter((candidate) => !candidate.alreadyCaptured) ?? [];
  const openCandidateIds = new Set(
    openCandidates.map((candidate) => candidate.candidate_id),
  );
  const workItemByCandidate = new Map(
    workItems
      // An auto-repair retry of a failed reference-import candidate keeps
      // the candidate's work-item id — its live state belongs on the
      // candidate row too.
      .filter(
        (item) =>
          item.origin === "reference_import" ||
          (item.origin === "auto_repair" && item.targetSourceId === undefined),
      )
      .map((item) => [item.workItemId, item]),
  );
  const correctionsBySource = new Map<string, SourceWorkItemVM[]>();
  for (const item of workItems) {
    if (
      (item.origin === "correction" || item.origin === "auto_repair") &&
      item.targetSourceId !== undefined
    ) {
      const list = correctionsBySource.get(item.targetSourceId) ?? [];
      list.push(item);
      correctionsBySource.set(item.targetSourceId, list);
    }
  }
  const standaloneWorkItems = workItems.filter((item) => {
    if (item.origin === "correction" || item.targetSourceId !== undefined) {
      // Renders as state on the target source's row.
      return false;
    }
    if (item.origin === "manual") {
      return true;
    }
    // reference_import and target-less auto_repair items render on their
    // candidate's row while that candidate is still open.
    return !openCandidateIds.has(item.workItemId);
  });
  const suggestionByWorkItem = new Map(
    repairSuggestions.flatMap((entry) =>
      entry.target.kind === "capture_failure"
        ? [[entry.target.workItemId, entry] as const]
        : [],
    ),
  );
  const suggestionBySource = new Map(
    repairSuggestions.flatMap((entry) =>
      entry.target.kind === "source"
        ? [[entry.target.sourceId, entry] as const]
        : [],
    ),
  );
  const readyCandidateCount = openCandidates.filter(
    (candidate) => candidate.selected,
  ).length;

  return {
    openCandidates,
    workItemByCandidate,
    correctionsBySource,
    standaloneWorkItems,
    suggestionByWorkItem,
    suggestionBySource,
    readyCandidateCount,
  };
}
