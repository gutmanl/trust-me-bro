"use client";

import type { BriefingViewModel, ClaimMarkerVM } from "@/lib/pipeline";
import { STATUS_LABELS, statusBadgeClassName } from "../../status-labels";

/**
 * The frozen briefing with inline claim markers (TMB-33): each anchored
 * claim appears under its paragraph with status badge and its numbered
 * evidence references; selecting a marker or reference opens the detail
 * panel. Purely presentational — anchor resolution and numbering come from
 * the shared briefing view model.
 */
export function BriefingPane({
  briefing,
  selectedClaimId,
  onSelect,
}: {
  briefing: BriefingViewModel;
  selectedClaimId: string | null;
  onSelect: (claimId: string, evidenceId?: string) => void;
}) {
  return (
    <div className="space-y-4">
      {briefing.paragraphs.map((paragraph) => (
        <div key={paragraph.index}>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
            {paragraph.text}
          </p>
          {paragraph.claims.map((marker) => (
            <ClaimMarker
              key={marker.claim.id}
              marker={marker}
              selected={marker.claim.id === selectedClaimId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}

      {briefing.unanchored.length > 0 ? (
        <div className="border-t border-slate-200 pt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Nicht zuordenbare Claims
          </h3>
          {briefing.unanchored.map((marker) => (
            <ClaimMarker
              key={marker.claim.id}
              marker={marker}
              selected={marker.claim.id === selectedClaimId}
              onSelect={onSelect}
              showAnchor
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ClaimMarker({
  marker,
  selected,
  onSelect,
  showAnchor = false,
}: {
  marker: ClaimMarkerVM;
  selected: boolean;
  onSelect: (claimId: string, evidenceId?: string) => void;
  showAnchor?: boolean;
}) {
  const { claim } = marker;
  return (
    <div
      className={`mt-2 flex flex-wrap items-center gap-2 rounded-md border-l-2 py-1 pl-3 text-xs ${
        selected
          ? "border-slate-700 bg-slate-100"
          : "border-slate-200 hover:bg-slate-50"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(claim.id)}
        className="flex items-center gap-2 text-left"
      >
        <span className="font-mono text-slate-500">{claim.id}</span>
        <span
          className={`rounded-full px-2 py-0.5 ${statusBadgeClassName(claim.status)}`}
        >
          {STATUS_LABELS[claim.status]}
        </span>
      </button>
      {marker.evidenceNumbers.length > 0 ? (
        <span className="flex gap-1">
          {marker.evidenceNumbers.map((number, index) => (
            <button
              key={number}
              type="button"
              onClick={() => onSelect(claim.id, claim.evidence[index]?.id)}
              className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-blue-700 hover:bg-blue-100"
            >
              [{number}]
            </button>
          ))}
        </span>
      ) : (
        <span className="text-slate-400">ohne Beleg</span>
      )}
      {showAnchor ? (
        <span className="text-slate-400">Anker: {claim.briefing_anchor}</span>
      ) : null}
    </div>
  );
}
