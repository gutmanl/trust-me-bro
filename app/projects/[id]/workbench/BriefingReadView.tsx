"use client";

import { Fragment } from "react";

import { SuccessBanner } from "@/app/components/ui";
import type {
  ClaimRepairSuggestionVM,
  MechanicalCapVM,
  BriefingViewModel,
  EvidenceDisplay,
  QueueEntry,
} from "@/lib/pipeline";
import { ClaimCard } from "../review/ClaimCard";
import type { ParagraphOption } from "../review/RepairPanel";
import { MarkdownBlock } from "./markdown";

/**
 * The reading half of the workbench's briefing pane, absorbed from the
 * former review workspace: the briefing as the reading column on the left,
 * every claim as a margin card beside its anchor paragraph on the right
 * (Google-Docs comment pattern). Hover or selection highlights paragraph and
 * cards together — the visible text↔claim link.
 *
 * Two changes against its review-page ancestor: paragraphs render as
 * Markdown (`MarkdownBlock`) instead of preformatted text, and every card
 * carries the paragraph list plus its own anchored paragraph, so the repair
 * panel can offer the two anchor repairs in place.
 *
 * Selection state, the effort timer and the live refresh live in the
 * workbench shell — this component renders, it never mutates.
 */
export function BriefingReadView({
  projectId,
  briefing,
  queue,
  evidenceDisplay,
  claimRepairSuggestions,
  mechanicalCaps,
  selectedClaimId,
  selectedEvidenceId,
  hoveredParagraph,
  currentSeconds,
  onSelectClaim,
  onHoverParagraph,
}: {
  projectId: string;
  briefing: BriefingViewModel;
  queue: QueueEntry[];
  evidenceDisplay: Record<string, EvidenceDisplay>;
  claimRepairSuggestions: Record<string, ClaimRepairSuggestionVM>;
  mechanicalCaps: Record<string, MechanicalCapVM>;
  selectedClaimId: string | null;
  selectedEvidenceId: string | null;
  hoveredParagraph: number | null;
  currentSeconds: () => number;
  onSelectClaim: (claimId: string, evidenceId?: string) => void;
  onHoverParagraph: (index: number | null) => void;
}) {
  const queueByClaim = new Map(queue.map((entry) => [entry.claim.id, entry]));
  const paragraphOptions: ParagraphOption[] = briefing.paragraphs.map(
    (paragraph) => ({ index: paragraph.index, text: paragraph.text }),
  );

  return (
    <div>
      {briefing.isFullyAdjudicated ? (
        <div className="mb-6">
          <SuccessBanner>
            Briefing geprüft – keine Aussage zur manuellen Überprüfung offen
            {briefing.unconfirmedCount > 0
              ? ` (${briefing.unconfirmedCount} Aussage(n) nicht bestätigt)`
              : ""}
            .
          </SuccessBanner>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] lg:gap-y-8">
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
                    ? () => onHoverParagraph(paragraph.index)
                    : undefined
                }
                onMouseLeave={
                  hasClaims ? () => onHoverParagraph(null) : undefined
                }
              >
                {/* Highlight sits on the paragraph itself, not the grid
                    cell: the cell stretches to the height of an expanded
                    card in the same row. */}
                <div
                  className={`-ml-4 max-w-[72ch] rounded-r-md border-l-2 py-1 pl-4 transition-colors ${
                    linked
                      ? "border-blue-400 bg-blue-50/70"
                      : "border-transparent"
                  }`}
                >
                  <MarkdownBlock text={paragraph.text} />
                </div>
              </div>
              {hasClaims ? (
                <div
                  className="space-y-3 lg:col-start-2"
                  onMouseEnter={() => onHoverParagraph(paragraph.index)}
                  onMouseLeave={() => onHoverParagraph(null)}
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
                      repairSuggestion={claimRepairSuggestions[marker.claim.id]}
                      mechanicalCap={mechanicalCaps[marker.claim.id]}
                      currentSeconds={currentSeconds}
                      onSelect={onSelectClaim}
                      paragraphs={paragraphOptions}
                      anchoredParagraph={paragraphOptions[paragraph.index]}
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
            Nicht zuordenbare Aussagen
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Die Textstellen dieser Aussagen verweisen auf keinen Absatz des
            Briefings.
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
                repairSuggestion={claimRepairSuggestions[marker.claim.id]}
                mechanicalCap={mechanicalCaps[marker.claim.id]}
                currentSeconds={currentSeconds}
                onSelect={onSelectClaim}
                showAnchor
                paragraphs={paragraphOptions}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
