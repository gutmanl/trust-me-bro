"use client";

import { useActionState, useState } from "react";

import {
  compactButtonClass,
  compactSecondaryButtonClass,
  ErrorBanner,
} from "@/app/components/ui";
import type {
  ProjectMetrics,
  RecheckPreview,
  VerificationState,
} from "@/lib/pipeline";
import type { ClaimStatus } from "@/lib/register";
import { STATUS_LABELS, STATUS_ORDER } from "../../status-labels";
import {
  activityLabel,
  StartBlockedNotice,
  useActivity,
  useStartGate,
} from "../RunStatusProvider";
import type { RunFormState } from "./actions";
import { startVerificationAction } from "./actions";
import { RecheckSweepDialog, SWEEP_COPY } from "./RecheckSweepDialog";

const initialState: RunFormState = { error: null };

/**
 * The Copywriting Contract's bar-side copy: the sweep's success line
 * (Surfaces 2 + 3) and the one-time post-run summary (Surface 6.1).
 *
 * Sentence 2 of the summary is P-11 option (a): the general statement that
 * a re-run of the SAME claim can reach a different result with no change to
 * the templates. It is carried once and transiently, here, rather than as a
 * caveat glued to every changed verdict — a permanent disclaimer on each
 * card would be read as a defect of that card.
 *
 * The measured run-to-run flip floor is deliberately NOT published: it is a
 * borderline-corpus figure under templates no project uses, and a standing
 * percentage is the strongest form of the overreliance risk this phase
 * exists to reduce. Counts only, never a rate.
 */
export const BAR_RECHECK_COPY = {
  sweepSuccess: (n: number): string =>
    `${n} Aussage${n === 1 ? "" : "n"} zur Nachprüfung vorgemerkt – mit ` +
    "„KI-Prüfung starten“ beginnt der Lauf.",
  sweepExcluded: (e: number): string =>
    `${e} Aussage${e === 1 ? " wurde" : "n wurden"} nicht vorgemerkt.`,
  postRun1: (changed: number, reverified: number): string =>
    `Erneute Prüfung abgeschlossen: ${changed} von ${reverified} erneut ` +
    `geprüften Aussage${reverified === 1 ? "" : "n"} ` +
    `${changed === 1 ? "kommt" : "kommen"} zu einem anderen Ergebnis als ` +
    "zuvor.",
  postRun2:
    "Eine erneute Prüfung derselben Aussage kann zu einem anderen Ergebnis " +
    "führen, auch ohne Änderung an den Prüfvorlagen.",
} as const;

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
  selectedClaimId,
  selectedClaimIsQueued,
  recheckPreview,
  reverification,
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
  /**
   * RERUN-04: the claim the reviewer currently has expanded, excluded from
   * a sweep and named in the confirmation's exclusions line.
   *
   * One id is enough, and that is the narrowing that makes this a prop
   * rather than a draft-state lift: `ComplaintDialog` renders only inside an
   * EXPANDED card and `useEffortTimer` is bound to the same value, so „the
   * claim with an open complaint draft" and „the claim with a running
   * effort timer" are both subsets of the selected claim.
   */
  selectedClaimId: string | null;
  /**
   * Whether that claim awaits manual adjudication.
   *
   * Rides along because the forcing step asks for the QUEUED count, and the
   * preview — computed server-side without any exclusion — cannot say
   * whether a claim it did not exclude is queued. Confirmed-ness needs no
   * such flag: it is the difference between the top rung and `all`.
   */
  selectedClaimIsQueued: boolean;
  /** All three rungs in one payload (04-06), so a rung change recomputes the
   * itemisation with no round trip and the displayed count cannot drift
   * from the count the submit acts on.
   *
   * Null when the preview could not be computed. A confirmation that cannot
   * itemise is worth less than no confirmation at all — the itemisation IS
   * the mitigation — so the trigger is omitted rather than shown over a
   * dialog that would fall back to a bare count. */
  recheckPreview: RecheckPreview | null;
  /** D-16's two absolute counts. Never divided, here or anywhere. */
  reverification: ProjectMetrics["reverification"];
}) {
  const [state, formAction, pending] = useActionState(
    startVerificationAction.bind(null, projectId),
    initialState,
  );
  const { blockedBy } = useStartGate("verification");
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweepResult, setSweepResult] = useState<{
    moved: number;
    excluded: number;
  } | null>(null);
  // Gated on the project's ACTIVITY rather than on the verification start
  // gate: that gate reports no blocker for a run of its OWN kind by design,
  // so gating the sweep on it would leave the trigger live during exactly
  // the run that makes the request impossible. A re-run request is blocked
  // by ANY activity.
  const activity = useActivity();
  const sweepBlockedBy = activity !== null ? activityLabel(activity) : null;
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
        <h2 className="text-sm font-semibold text-slate-700">Aussagen</h2>

        {everQueued > 0 ? (
          <>
            <p className="text-sm text-slate-700">
              {decided} von {everQueued} Aussage{everQueued === 1 ? "" : "n"}{" "}
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
              ? "Noch keine Aussagen – sie entstehen mit der Aussagen-Erfassung aus dem Briefing."
              : "Keine Aussage zur manuellen Überprüfung geroutet."}
          </p>
        )}

        {openCount > 0 ? (
          <button
            type="button"
            onClick={onJumpToNextOpen}
            className={compactSecondaryButtonClass}
          >
            Nächste offene Aussage ↓
          </button>
        ) : null}

        {existenceCheckRunning ? (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">
            Zitatprüfung läuft …
          </span>
        ) : openExistenceCount > 0 ? (
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700">
            {openExistenceCount} Aussage(n) ohne Zitatprüfung
          </span>
        ) : null}

        {verificationRunning ? (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">
            KI-Prüfung läuft …
          </span>
        ) : startable ? (
          <form action={formAction}>
            <button
              type="submit"
              disabled={pending}
              className={compactButtonClass}
            >
              {pending
                ? "Wird gestartet …"
                : verificationState.status === "interrupted" ||
                    verificationState.status === "halted"
                  ? `Prüfung fortsetzen (${verificationState.openClaims} Aussage(n) offen)`
                  : "KI-Prüfung starten"}
            </button>
          </form>
        ) : null}

        {/* Surface 2. Deliberately AFTER the start form and deliberately in
            the quiet outline register: the sweep marks claims, the start
            button runs them, and the primary in this bar stays the one that
            starts a run. „Behind the per-claim default" is not „hidden" —
            an undiscoverable sweep would push a reviewer into repeating the
            per-claim action dozens of times, which is worse for both quota
            and attention. What keeps it behind the default is that it never
            executes on a single press. */}
        {totalClaims > 0 && recheckPreview !== null ? (
          <button
            type="button"
            disabled={sweepBlockedBy !== null}
            onClick={() => setSweepOpen(true)}
            className={compactSecondaryButtonClass}
          >
            {SWEEP_COPY.trigger}
          </button>
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
          captured/existence_checked.

          The interrupted case is deliberately NOT gated on `reason`:
          `deriveVerificationState` only sets that field from a
          verification_run_completed event, and "interrupted" is by
          definition the state where that closing event never arrived (an
          opening bracket without a close). Gating all three arms on `reason`
          — as the first version of this block did — made the interrupted
          message unreachable, i.e. hid exactly the state that most needs
          saying. Hence: a fixed message for interrupted, the event's own
          reason only where the event exists. */}
      {verificationState.status === "interrupted" ? (
        <p className="mt-2 text-xs text-amber-700">
          KI-Prüfung unterbrochen – über „Prüfung fortsetzen“ wieder aufnehmen;
          fortgesetzt wird nur mit den offenen Aussagen.
        </p>
      ) : verificationState.reason !== undefined &&
        (verificationState.status === "halted" ||
          verificationState.status === "completed") ? (
        <p
          className={`mt-2 text-xs ${
            verificationState.status === "completed"
              ? "text-slate-500"
              : "text-amber-700"
          }`}
        >
          {verificationState.status === "halted"
            ? "KI-Prüfung angehalten – es verbleiben offene Aussagen. "
            : "Letzte KI-Prüfung: "}
          {verificationState.reason}
        </p>
      ) : null}

      {/* Widened from `blockedBy` to ANY activity (RERUN-07): the sweep
          trigger above is disabled during a run of the verification kind
          too, and a control that is disabled without a visible explanation
          is exactly the silent failure RERUN-07 names. Visible text, never
          a `title` alone — a tooltip only exists for a pointer that hovers
          it. `blockedBy` still gates the START button, which is a different
          question. */}
      {verificationBlockedReason !== null ? (
        <p className="mt-2 text-xs text-amber-700">
          {verificationBlockedReason}
        </p>
      ) : sweepBlockedBy !== null ? (
        <div className="mt-2">
          <StartBlockedNotice label={sweepBlockedBy} />
        </div>
      ) : null}

      {/* The sweep's own outcome, in the bar rather than in the dialog: the
          dialog is gone by the time the reviewer reads this, and the button
          that acts on what it marked is right here. */}
      {sweepResult !== null ? (
        <p className="mt-2 text-xs text-slate-500">
          {BAR_RECHECK_COPY.sweepSuccess(sweepResult.moved)}
          {sweepResult.excluded > 0
            ? " " + BAR_RECHECK_COPY.sweepExcluded(sweepResult.excluded)
            : ""}
        </p>
      ) : null}

      {/* Surface 6.1 — the one-time post-run summary (D-16). Present only
          for the most recently completed run that a re-run bracket preceded,
          and gone as soon as any later run completes; never a zero state and
          never standing furniture. Two absolute counts, never a ratio: a
          percentage here would be read as an agreement or accuracy rate,
          which is precisely the overreliance failure this phase mitigates. */}
      {verificationState.precededByRecheck &&
      verificationState.completedAt !== undefined &&
      reverification.last_run !== null &&
      reverification.last_run.reverified_claims > 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          {/* WR-02: the RUN-scoped pair, not the project-lifetime one. The
              gate above is per-run, so printing the cumulative totals read
              as the outcome of a run that may have touched two claims —
              and hid that run's actual result in both directions. The
              cumulative pair stays on the metrics page, where the framing
              is explicitly project-level. */}
          {BAR_RECHECK_COPY.postRun1(
            reverification.last_run.changed_result_claims,
            reverification.last_run.reverified_claims,
          )}{" "}
          {BAR_RECHECK_COPY.postRun2}
        </p>
      ) : null}

      <ErrorBanner message={state.error} />

      {sweepOpen && recheckPreview !== null ? (
        <RecheckSweepDialog
          projectId={projectId}
          preview={recheckPreview}
          selectedClaimId={selectedClaimId}
          selectedClaimIsQueued={selectedClaimIsQueued}
          onClose={() => setSweepOpen(false)}
          onRequested={setSweepResult}
        />
      ) : null}
    </div>
  );
}
