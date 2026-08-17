"use client";

import { useState } from "react";

import { ConnectionLostNotice } from "@/app/components/ui";
import { useProjectEvents } from "@/app/lib/ProjectEventStream";
import type {
  BriefingDraft,
  BriefingViewModel,
  EvidenceDisplay,
  ExtractionActivity,
  QueueEntry,
  RepairActionVM,
  SourceWorkItemVM,
  VerificationState,
} from "@/lib/pipeline";
import type { BriefingImport, ClaimStatus } from "@/lib/register";
import { useEffortTimer } from "../review/useEffortTimer";
import { BriefingPane } from "./BriefingPane";
import { ClaimsOverviewBar } from "./ClaimsOverviewBar";
import type { OpenChainTrigger } from "@/lib/pipeline";
import { SourcesRail, type ReferenceImportVM } from "./SourcesRail";
import type { SourceRowVM } from "./SourceRow";
import { useCollapsedRefresh } from "./use-collapsed-refresh";

/**
 * The unified project workbench (workbench epic): briefing, claims and
 * sources on ONE page instead of five staged step pages the user had to walk
 * through in order. The staging was an artefact of building the pipeline
 * bottom-up; the actual work is iterative — a source is captured because a
 * claim lacks evidence, a passage is corrected because its claim was
 * contested — and every one of those loops used to cross a page boundary.
 *
 * This shell owns exactly what the panes must agree on: which claim is
 * selected, which paragraph is hovered, and the effort timer that runs while
 * a claim is open. Everything durable renders server-side from the register
 * and is refreshed here as runs progress.
 */
export function Workbench({
  projectId,
  researchQuestion,
  briefing,
  briefingText,
  briefingMeta,
  draft,
  queue,
  evidenceDisplay,
  counts,
  totalClaims,
  openExistenceCount,
  verificationState,
  verificationBlockedReason,
  sources,
  workItems,
  interruptedTriggers,
  repairSuggestions,
  sourceSetRevision,
  pendingTriggers,
  extractionActivity,
  referenceImport,
}: {
  projectId: string;
  researchQuestion: string;
  briefing: BriefingViewModel | null;
  briefingText: string | null;
  briefingMeta: BriefingImport | null;
  draft: BriefingDraft | null;
  queue: QueueEntry[];
  evidenceDisplay: Record<string, EvidenceDisplay>;
  counts: Record<ClaimStatus, number>;
  totalClaims: number;
  openExistenceCount: number;
  verificationState: VerificationState;
  verificationBlockedReason: string | null;
  sources: SourceRowVM[];
  workItems: SourceWorkItemVM[];
  interruptedTriggers: OpenChainTrigger[];
  repairSuggestions: RepairActionVM[];
  sourceSetRevision: number;
  pendingTriggers: number;
  extractionActivity: ExtractionActivity;
  referenceImport: ReferenceImportVM | null;
}) {
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(
    null,
  );
  const [hoveredParagraph, setHoveredParagraph] = useState<number | null>(null);
  const { currentSeconds } = useEffortTimer(selectedClaimId);
  const refresh = useCollapsedRefresh();

  // Live refresh while any run streams progress: every finished item updates
  // the durable register, so re-render the server components per item instead
  // of waiting for the run to end. Collapsed (see the hook) because a
  // reconnect replays a run's whole event log in one burst.
  const { connectionLost, activeRun } = useProjectEvents(
    undefined,
    (envelope) => {
      if (envelope.event.type === "item_completed") {
        refresh();
      }
    },
  );

  const selectClaim = (claimId: string, evidenceId?: string): void => {
    // Selecting the already-expanded claim again collapses it — unless the
    // click targeted a specific evidence reference.
    setSelectedClaimId((previous) =>
      previous === claimId && evidenceId === undefined ? null : claimId,
    );
    setSelectedEvidenceId(evidenceId ?? null);
  };

  // Progress denominator: every claim that is or ever was routed to
  // adjudication — auto-confirmed claims that never needed a decision would
  // otherwise inflate the bar.
  const orderedClaims = briefing?.orderedClaims ?? [];
  const everQueued = orderedClaims.filter(
    ({ claim }) =>
      claim.status === "pending_adjudication" ||
      claim.history.some((entry) => entry.to_status === "pending_adjudication"),
  ).length;
  const openCount = briefing?.openCount ?? 0;

  // Open claims in briefing order (anchor position, then id) — the order the
  // "next open claim" jump walks through.
  const openClaimIds = orderedClaims
    .filter((marker) => marker.claim.status === "pending_adjudication")
    .map((marker) => marker.claim.id);

  const jumpToNextOpen = (): void => {
    const currentIndex = selectedClaimId
      ? openClaimIds.indexOf(selectedClaimId)
      : -1;
    const nextId = openClaimIds[(currentIndex + 1) % openClaimIds.length];
    if (nextId === undefined) {
      return;
    }
    setSelectedClaimId(nextId);
    setSelectedEvidenceId(null);
    document
      .getElementById(`claim-card-${nextId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    // Width is the project page's business (see `wideContainerClass`): this
    // component is one section of it, not the page's layout container.
    <section aria-label="Arbeitsbereich">
      <ClaimsOverviewBar
        projectId={projectId}
        counts={counts}
        totalClaims={totalClaims}
        decided={everQueued - openCount}
        everQueued={everQueued}
        openCount={openCount}
        openExistenceCount={openExistenceCount}
        existenceCheckRunning={activeRun?.kind === "existence_check"}
        verificationRunning={activeRun?.kind === "verification"}
        verificationState={verificationState}
        verificationBlockedReason={verificationBlockedReason}
        runBarVisible={activeRun !== null}
        onJumpToNextOpen={jumpToNextOpen}
      />

      {activeRun !== null && connectionLost ? (
        <div className="mt-4">
          <ConnectionLostNotice />
        </div>
      ) : null}

      <div className="mt-6 grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <BriefingPane
          projectId={projectId}
          researchQuestion={researchQuestion}
          briefing={briefing}
          briefingText={briefingText}
          briefingMeta={briefingMeta}
          draft={draft}
          queue={queue}
          evidenceDisplay={evidenceDisplay}
          selectedClaimId={selectedClaimId}
          selectedEvidenceId={selectedEvidenceId}
          hoveredParagraph={hoveredParagraph}
          currentSeconds={currentSeconds}
          onSelectClaim={selectClaim}
          onHoverParagraph={setHoveredParagraph}
        />
        <SourcesRail
          projectId={projectId}
          sources={sources}
          workItems={workItems}
          interruptedTriggers={interruptedTriggers}
          repairSuggestions={repairSuggestions}
          sourceSetRevision={sourceSetRevision}
          pendingTriggers={pendingTriggers}
          extractionActivity={extractionActivity}
          referenceImport={referenceImport}
          hasBriefing={briefing !== null}
        />
      </div>
    </section>
  );
}
