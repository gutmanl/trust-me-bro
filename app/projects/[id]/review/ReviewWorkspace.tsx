"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";

import { ConnectionLostNotice, SuccessBanner } from "@/app/components/ui";
import { useJobStream } from "@/app/lib/useJobStream";
import type {
  BriefingViewModel,
  EvidenceDisplay,
  QueueEntry,
} from "@/lib/pipeline";
import { ClaimCard } from "./ClaimCard";
import { useEffortTimer } from "./useEffortTimer";

/**
 * Client shell of the review workspace: the frozen briefing as the reading
 * column on the left, every claim as a margin card beside its anchor
 * paragraph on the right (Google-Docs comment pattern), and the adjudication
 * progress as a sticky bar on top. Hover or selection highlights paragraph
 * and cards together — the visible text↔claim link. Refreshes the
 * server-rendered data while a verification run streams progress (TMB-33).
 * Durable truth stays in the register — this component never mutates
 * anything itself.
 */
export function ReviewWorkspace({
  projectId,
  briefing,
  queue,
  evidenceDisplay,
  verificationActive,
}: {
  projectId: string;
  briefing: BriefingViewModel;
  queue: QueueEntry[];
  evidenceDisplay: Record<string, EvidenceDisplay>;
  verificationActive: boolean;
}) {
  const router = useRouter();
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(
    null,
  );
  const [hoveredParagraph, setHoveredParagraph] = useState<number | null>(null);
  const { currentSeconds } = useEffortTimer(selectedClaimId);

  // Live refresh during a verification run: every finished claim updates the
  // durable register, so re-render the server components per item instead of
  // waiting for the run to end.
  const { connectionLost } = useJobStream({
    streamUrl: `/api/projects/${projectId}/verification/stream`,
    active: verificationActive,
    describe: () => null,
    onEvent: (event) => {
      if (event.type === "item_completed") {
        router.refresh();
      }
    },
    onDone: () => {
      router.refresh();
    },
  });

  const selectClaim = (claimId: string, evidenceId?: string): void => {
    // Selecting the already-expanded claim again collapses it — unless the
    // click targeted a specific evidence reference.
    setSelectedClaimId((previous) =>
      previous === claimId && evidenceId === undefined ? null : claimId,
    );
    setSelectedEvidenceId(evidenceId ?? null);
  };

  const queueByClaim = new Map(queue.map((entry) => [entry.claim.id, entry]));

  // Progress denominator: every claim that is or ever was routed to
  // adjudication — auto-confirmed claims that never needed a decision would
  // otherwise inflate the bar.
  const everQueued = briefing.orderedClaims.filter(
    ({ claim }) =>
      claim.status === "pending_adjudication" ||
      claim.history.some((entry) => entry.to_status === "pending_adjudication"),
  ).length;
  const decided = everQueued - briefing.openCount;

  // Open claims in briefing order (anchor position, then id) — the order the
  // "next open claim" jump walks through.
  const openClaimIds = briefing.orderedClaims
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
    <div className="mx-[calc(50%-50vw)] px-6">
      {everQueued > 0 ? (
        <div className="sticky top-0 z-10 -mx-6 border-b border-slate-200 bg-slate-50/95 px-6 py-3 backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="text-sm font-medium text-slate-700">
              {decided} von {everQueued} Claim{everQueued === 1 ? "" : "s"}{" "}
              entschieden
            </p>
            <div className="h-2 min-w-40 flex-1 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-slate-800 transition-[width] duration-300"
                style={{
                  width: `${Math.round((decided / everQueued) * 100)}%`,
                }}
              />
            </div>
            {briefing.openCount > 0 ? (
              <button
                type="button"
                onClick={jumpToNextOpen}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Nächster offener Claim ↓
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="py-6">
        {connectionLost ? (
          <div className="mb-6">
            <ConnectionLostNotice />
          </div>
        ) : null}
        {briefing.isFullyAdjudicated ? (
          <div className="mb-6">
            <SuccessBanner>
              Briefing geprüft – kein Claim zur Adjudikation offen
              {briefing.unconfirmedCount > 0
                ? ` (${briefing.unconfirmedCount} Claim(s) nicht bestätigt)`
                : ""}
              .
            </SuccessBanner>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)] lg:gap-y-8">
          {briefing.paragraphs.map((paragraph) => {
            const hasClaims = paragraph.claims.length > 0;
            const linked =
              hasClaims &&
              (hoveredParagraph === paragraph.index ||
                paragraph.claims.some(
                  (marker) => marker.claim.id === selectedClaimId,
                ));
            return (
              <Fragment key={paragraph.index}>
                <div
                  className="lg:col-start-1"
                  onMouseEnter={
                    hasClaims
                      ? () => setHoveredParagraph(paragraph.index)
                      : undefined
                  }
                  onMouseLeave={
                    hasClaims ? () => setHoveredParagraph(null) : undefined
                  }
                >
                  {/* Highlight sits on the paragraph itself, not the grid
                      cell: the cell stretches to the height of an expanded
                      card in the same row. */}
                  <p
                    className={`-ml-4 max-w-[72ch] rounded-r-md border-l-2 py-1 pl-4 text-[15px] leading-relaxed whitespace-pre-wrap text-slate-800 transition-colors ${
                      linked
                        ? "border-blue-400 bg-blue-50/70"
                        : "border-transparent"
                    }`}
                  >
                    {paragraph.text}
                  </p>
                </div>
                {hasClaims ? (
                  <div
                    className="space-y-3 lg:col-start-2"
                    onMouseEnter={() => setHoveredParagraph(paragraph.index)}
                    onMouseLeave={() => setHoveredParagraph(null)}
                  >
                    {paragraph.claims.map((marker) => (
                      <ClaimCard
                        key={marker.claim.id}
                        projectId={projectId}
                        marker={marker}
                        routing={
                          queueByClaim.get(marker.claim.id)?.routing ?? null
                        }
                        queuedAt={queueByClaim.get(marker.claim.id)?.queuedAt}
                        selected={marker.claim.id === selectedClaimId}
                        linked={linked}
                        selectedEvidenceId={selectedEvidenceId}
                        evidenceDisplay={evidenceDisplay}
                        currentSeconds={currentSeconds}
                        onSelect={selectClaim}
                      />
                    ))}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>

        {briefing.unanchored.length > 0 ? (
          <div className="mt-10 border-t border-slate-200 pt-6">
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Nicht zuordenbare Claims
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Die Anker dieser Claims verweisen auf keinen Absatz des Briefings.
            </p>
            <div className="mt-3 max-w-xl space-y-3">
              {briefing.unanchored.map((marker) => (
                <ClaimCard
                  key={marker.claim.id}
                  projectId={projectId}
                  marker={marker}
                  routing={queueByClaim.get(marker.claim.id)?.routing ?? null}
                  queuedAt={queueByClaim.get(marker.claim.id)?.queuedAt}
                  selected={marker.claim.id === selectedClaimId}
                  linked={false}
                  selectedEvidenceId={selectedEvidenceId}
                  evidenceDisplay={evidenceDisplay}
                  currentSeconds={currentSeconds}
                  onSelect={selectClaim}
                  showAnchor
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
