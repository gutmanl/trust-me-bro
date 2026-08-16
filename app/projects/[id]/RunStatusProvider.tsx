"use client";

import { useActionState } from "react";

import {
  RunControls,
  type RunControlPhase,
} from "@/app/components/RunControls";
import { useProjectEvents } from "@/app/lib/ProjectEventStream";
import {
  cancelActivityAction,
  type RunControlFormState,
} from "@/app/lib/run-control-actions";
import type { ActiveRunStatus, ProjectActivity } from "@/lib/pipeline";

/** German labels for the runner's kinds, for the status bar and the gating
 * notes. Unknown kinds fall back to a neutral word rather than leaking the
 * internal token.
 *
 * Client-side copy of the RUN half of lib/pipeline/runs/labels.ts, kept
 * because the barrel is server-only (it reaches node:fs) and a client
 * component must not bundle it. The off-runner triggers need no entry here —
 * their German description travels inside the activity payload, computed
 * server-side where the target is known. tests/run-kind-labels.test.ts pins
 * the two maps against each other so they cannot drift. */
const RUN_KIND_LABELS: Record<string, string> = {
  extraction: "Aussagen-Erfassung",
  verification: "KI-Prüfung",
  reference_scan: "Referenz-Scan",
  source_capture: "Quellenerfassung",
  research: "Recherche",
  relevance: "Relevanzprüfung",
  existence_check: "Zitatprüfung",
};

export function runKindLabel(kind: string | null): string {
  return (kind && RUN_KIND_LABELS[kind]) || "Lauf";
}

/** The activity's German name, whichever half it lives on. */
function activityLabel(activity: ProjectActivity): string {
  return activity.source === "run"
    ? runKindLabel(activity.kind)
    : activity.description;
}

/** The project's active run, or null. Consumed by panels that follow runner
 * runs. Reads the shared project event stream — the one place that
 * reconciles the server snapshot with live progress. */
export function useRunStatus(): ActiveRunStatus | null {
  return useProjectEvents().activeRun;
}

/** The project's current activity — a runner run OR an off-runner chain
 * trigger — or null (run visibility). What the status bar and the
 * start-gating read: nothing that occupies the project may be invisible. */
export function useActivity(): ProjectActivity | null {
  return useProjectEvents().activity;
}

/**
 * Start-gating for a panel of kind `ownKind`: returns the German label of a
 * DIFFERENT activity currently occupying the project's single writer, or
 * null when the panel is free to start. A run of the panel's own kind never
 * blocks it — that panel shows its own live progress instead. Chain
 * triggers gate too (run visibility): they hold the same single-writer
 * seat, only invisibly before.
 */
export function useStartGate(ownKind: string): { blockedBy: string | null } {
  const activity = useActivity();
  if (!activity || activity.kind === ownKind) {
    return { blockedBy: null };
  }
  return { blockedBy: activityLabel(activity) };
}

/** The note shown in place of a start button when a different run holds the
 * project's single writer. Shared so every panel gates identically. */
export function StartBlockedNotice({ label }: { label: string }) {
  return (
    <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      {label} läuft gerade – bitte abwarten. Pro Projekt kann nur ein Lauf
      gleichzeitig laufen.
    </p>
  );
}

/**
 * Makes the project's active run visible and controllable from every page
 * (runner UI): the sticky bar plus the start-gating every panel reads.
 *
 * Since the workbench epic's unified event stream this is a pure CONSUMER —
 * the snapshot reconciliation (adopt the server's run identity, follow live
 * progress, adopt a run the auto-chain started without a page refresh) lives
 * once in ProjectEventStreamProvider, which the project layout wraps around
 * this component. Since the run-visibility work the bar shows the UNIFIED
 * activity — a runner run with its controls, or an off-runner chain trigger
 * with a cancel of its own — while useRunStatus keeps its run-only shape
 * for the panels that follow runner runs.
 */
export function RunStatusProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const activity = useActivity();

  return (
    <>
      {activity ? (
        <RunStatusBar projectId={projectId} activity={activity} />
      ) : null}
      {children}
    </>
  );
}

/** The persistent bar: which activity occupies the project — a run with its
 * phase, n/m progress and pause/cancel, or an off-runner chain trigger with
 * its cancel — on every project page. Everything that can block future work
 * shows here, and everything shown here can be cancelled (run visibility). */
function RunStatusBar({
  projectId,
  activity,
}: {
  projectId: string;
  activity: ProjectActivity;
}) {
  return (
    <div className="sticky top-0 z-20 mb-4 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-sky-900">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-500" />
          <span className="font-medium">{activityLabel(activity)} läuft</span>
          {activity.source === "run" && activity.total > 0 ? (
            <span className="text-sky-700">
              · {Math.min(activity.completed, activity.total)}/{activity.total}
            </span>
          ) : null}
        </div>
        {activity.source === "run" && activity.kind ? (
          <RunControls
            projectId={projectId}
            kind={activity.kind}
            phase={activity.phase as RunControlPhase}
          />
        ) : activity.source === "trigger" ? (
          <TriggerCancelControl projectId={projectId} activity={activity} />
        ) : null}
      </div>
    </div>
  );
}

/** Cancel-only control for an off-runner chain trigger: a trigger has no
 * items, so there is nothing to pause — but it must always be stoppable. */
function TriggerCancelControl({
  projectId,
  activity,
}: {
  projectId: string;
  activity: ProjectActivity & { source: "trigger" };
}) {
  const initial: RunControlFormState = { error: null };
  const [state, formAction, pending] = useActionState(
    cancelActivityAction.bind(null, projectId),
    initial,
  );
  const cancelling = activity.phase === "cancelling";
  return (
    <div className="flex items-center gap-2">
      {state.error ? (
        <span className="text-xs text-red-700">{state.error}</span>
      ) : null}
      <form action={formAction}>
        <button
          type="submit"
          disabled={pending || cancelling}
          className="rounded-md border border-sky-300 bg-white px-3 py-1 text-xs font-medium text-sky-900 hover:bg-sky-100 disabled:opacity-50"
        >
          {cancelling ? "Wird abgebrochen …" : "Abbrechen"}
        </button>
      </form>
    </div>
  );
}
