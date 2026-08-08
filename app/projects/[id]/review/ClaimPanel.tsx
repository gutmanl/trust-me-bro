"use client";

import type { Claim } from "@/lib/pipeline";
import { STATUS_LABELS, statusBadgeClassName } from "../../status-labels";

/**
 * Right-hand panel of the review workspace. Detail rendering of evidence,
 * judgments and the adjudication actions arrives with TMB-34/35; this shell
 * shows the selected claim's Leitsatz and status so the briefing selection
 * has a visible target from the start.
 */
export function ClaimPanel({ claim }: { claim: Claim | null }) {
  if (!claim) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
        Claim oder Beleg im Briefing auswählen, um Details zu sehen.
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-xs text-slate-500">{claim.id}</span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${statusBadgeClassName(claim.status)}`}
        >
          {STATUS_LABELS[claim.status]}
        </span>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Leitsatz (Claim)
        </h3>
        <p className="mt-1 text-sm text-slate-800">{claim.text}</p>
      </div>
      <p className="text-xs text-slate-400">{claim.history.at(-1)?.reason}</p>
    </div>
  );
}
