"use client";

import { useActionState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import type { ClaimStatus } from "@/lib/register";
import { STATUS_LABELS, STATUS_ORDER } from "../../status-labels";
import { StartBlockedNotice, useStartGate } from "../RunStatusProvider";
import type { RunFormState } from "./actions";
import { startVerificationAction } from "./actions";

const initialState: RunFormState = { error: null };

/**
 * The workbench's sticky header over the claims: how far adjudication has
 * come, how the claims are distributed over the status model, what the
 * deterministic stage-1 check still owes, and the one button that starts the
 * LLM stages.
 *
 * Progress denominator is deliberately "every claim that is or ever was
 * routed to adjudication", not the claim total: auto-confirmed claims that
 * never needed a human decision would otherwise inflate the bar into
 * meaninglessness.
 */
export function ClaimsOverviewBar({
  projectId,
  counts,
  totalClaims,
  decided,
  everQueued,
  openCount,
  openExistenceCount,
  existenceCheckRunning,
  verificationBlockedReason,
  onJumpToNextOpen,
}: {
  projectId: string;
  counts: Record<ClaimStatus, number>;
  totalClaims: number;
  /** Claims ever routed to adjudication that are no longer pending. */
  decided: number;
  everQueued: number;
  /** Claims currently awaiting adjudication. */
  openCount: number;
  /** Claims whose stage-1 existence check is still outstanding. */
  openExistenceCount: number;
  existenceCheckRunning: boolean;
  /** German reason the verification run cannot start yet, or null. */
  verificationBlockedReason: string | null;
  onJumpToNextOpen: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    startVerificationAction.bind(null, projectId),
    initialState,
  );
  const { blockedBy } = useStartGate("verification");
  const startable =
    !pending && !blockedBy && verificationBlockedReason === null;

  return (
    <div className="sticky top-0 z-10 -mx-6 border-b border-slate-200 bg-slate-50/95 px-6 py-3 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Claims</h2>

        {everQueued > 0 ? (
          <>
            <p className="text-sm text-slate-700">
              {decided} von {everQueued} Claim{everQueued === 1 ? "" : "s"}{" "}
              entschieden
            </p>
            <div className="h-2 min-w-32 flex-1 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-slate-800 transition-[width] duration-300"
                style={{
                  width: `${Math.round((decided / everQueued) * 100)}%`,
                }}
              />
            </div>
          </>
        ) : (
          <p className="flex-1 text-sm text-slate-500">
            {totalClaims === 0
              ? "Noch keine Claims – sie entstehen mit der Extraktion aus dem Briefing."
              : "Kein Claim zur Adjudikation geroutet."}
          </p>
        )}

        {openCount > 0 ? (
          <button
            type="button"
            onClick={onJumpToNextOpen}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            Nächster offener Claim ↓
          </button>
        ) : null}

        {existenceCheckRunning ? (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">
            Existenzprüfung läuft …
          </span>
        ) : openExistenceCount > 0 ? (
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700">
            {openExistenceCount} Claim(s) ohne Existenzprüfung
          </span>
        ) : null}

        {startable ? (
          <form action={formAction}>
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
            >
              Attribution &amp; Kalibrierung starten
            </button>
          </form>
        ) : null}
      </div>

      {totalClaims > 0 ? (
        <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
          {STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => (
            <div key={status} className="flex items-baseline gap-1">
              <dt className="text-slate-500">{STATUS_LABELS[status]}:</dt>
              <dd className="font-semibold text-slate-800">{counts[status]}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {verificationBlockedReason !== null ? (
        <p className="mt-2 text-xs text-amber-700">
          {verificationBlockedReason}
        </p>
      ) : blockedBy ? (
        <div className="mt-2">
          <StartBlockedNotice label={blockedBy} />
        </div>
      ) : null}
      <ErrorBanner message={state.error} />
    </div>
  );
}
