"use client";

import { useActionState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import type { VerificationState } from "@/lib/pipeline";
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
  verificationRunning,
  verificationState,
  verificationBlockedReason,
  runBarVisible,
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
  /** A verification run is live. `useStartGate` cannot tell us this — it
   * deliberately reports null for one's OWN kind, because a panel that
   * starts a run is supposed to show that run's progress instead of gating
   * itself. The deleted VerificationPanel had a `watching` flag for exactly
   * this; here the shared stream's active run takes its place. */
  verificationRunning: boolean;
  verificationState: VerificationState;
  /** German reason the verification run cannot start yet, or null. */
  verificationBlockedReason: string | null;
  /** The run status bar is on screen and also sticks to the top — the
   * overview bar has to dock below it rather than under it. */
  runBarVisible: boolean;
  onJumpToNextOpen: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    startVerificationAction.bind(null, projectId),
    initialState,
  );
  const { blockedBy } = useStartGate("verification");
  // Nothing left for a run to do is not an error the user should discover by
  // pressing a button that throws VerificationPreconditionError — an
  // interrupted run is the one case where "no open claims" still has work
  // (the spot check).
  const hasWork =
    verificationState.openClaims > 0 ||
    verificationState.status === "interrupted";
  const startable =
    !pending &&
    !blockedBy &&
    !verificationRunning &&
    hasWork &&
    verificationBlockedReason === null;

  return (
    <div
      className={`sticky z-10 -mx-6 border-b border-slate-200 bg-slate-50/95 px-6 py-3 backdrop-blur ${
        // The run status bar (sticky top-0 z-20) is taller than nothing and
        // shorter than 4rem, so docking here keeps both readable while a run
        // is live without leaving a gap when there is none.
        runBarVisible ? "top-16" : "top-0"
      }`}
    >
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

        {verificationRunning ? (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">
            Attribution &amp; Kalibrierung laufen …
          </span>
        ) : startable ? (
          <form action={formAction}>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {pending
                ? "Wird gestartet …"
                : verificationState.status === "interrupted" ||
                    verificationState.status === "halted"
                  ? `Prüfung fortsetzen (${verificationState.openClaims} Claim(s) offen)`
                  : "Attribution & Kalibrierung starten"}
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

      {/* Durable outcome of the last verification run — the half of the
          deleted verification page that was not volatile run progress. An
          interrupted or halted run leaves claims unchecked, and without this
          line that would be visible only as claims quietly sitting in
          captured/existence_checked. */}
      {verificationState.reason !== undefined &&
      (verificationState.status === "interrupted" ||
        verificationState.status === "halted" ||
        verificationState.status === "completed") ? (
        <p
          className={`mt-2 text-xs ${
            verificationState.status === "completed"
              ? "text-slate-500"
              : "text-amber-700"
          }`}
        >
          {verificationState.status === "interrupted"
            ? "Prüflauf unterbrochen – Fortsetzen prüft nur die offenen Claims. "
            : verificationState.status === "halted"
              ? "Prüflauf angehalten – es verbleiben offene Claims. "
              : "Letzter Prüflauf: "}
          {verificationState.reason}
        </p>
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
