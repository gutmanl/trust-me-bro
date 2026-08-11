"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useState } from "react";

import {
  RunControls,
  type RunControlPhase,
} from "@/app/components/RunControls";
import { useJobStream } from "@/app/lib/useJobStream";
import type { ActiveRunStatus } from "@/lib/pipeline";

/** German labels for the runner's kinds, for the status bar and the gating
 * notes. Unknown kinds fall back to a neutral word rather than leaking the
 * internal token. */
const RUN_KIND_LABELS: Record<string, string> = {
  extraction: "Extraktion",
  verification: "Prüflauf",
  reference_scan: "Referenz-Scan",
  reference_capture: "Quellenerfassung",
  research: "Recherche",
  relevance: "Relevanzprüfung",
  existence_check: "Existenzprüfung",
};

export function runKindLabel(kind: string | null): string {
  return (kind && RUN_KIND_LABELS[kind]) || "Lauf";
}

const RunStatusContext = createContext<ActiveRunStatus | null>(null);

/** The project's active run, or null. Consumed by the status bar and by every
 * start button (via useStartGate). */
export function useRunStatus(): ActiveRunStatus | null {
  return useContext(RunStatusContext);
}

/**
 * Start-gating for a panel of kind `ownKind`: returns the German label of a
 * DIFFERENT run currently occupying the project's single writer, or null when
 * the panel is free to start. A run of the panel's own kind never blocks it —
 * that panel shows its own live progress instead.
 */
export function useStartGate(ownKind: string): { blockedBy: string | null } {
  const status = useRunStatus();
  if (!status || status.kind === ownKind) {
    return { blockedBy: null };
  }
  return { blockedBy: runKindLabel(status.kind) };
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
 * (runner UI). Seeds from the server's getActiveRun snapshot, then follows the
 * kind-agnostic status stream for live phase/progress; on the run's terminal
 * event it refreshes so server-rendered state (and this snapshot) catch up.
 *
 * `initial` is re-read on every server render, so a run STARTED on the current
 * page (its start action revalidates this layout) flips the snapshot to
 * non-null and opens the stream — no polling. State is adopted only on the
 * null↔active edge, so live stream progress is never clobbered by an unrelated
 * revalidation.
 */
export function RunStatusProvider({
  projectId,
  initial,
  children,
}: {
  projectId: string;
  initial: ActiveRunStatus | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<ActiveRunStatus | null>(initial);

  // Adopt the server snapshot only when the run IDENTITY changes — a new run,
  // a run that ended, or one run handed off to another — never on an
  // incidental revalidation, so live stream progress is not clobbered.
  // Comparing runIds (not mere existence) also catches a runA→runB hand-off
  // with no client-observed gap, which a boolean existence check would miss.
  if ((initial?.runId ?? null) !== (status?.runId ?? null)) {
    setStatus(initial);
  }

  useJobStream({
    // runId in the URL so a runA→runB hand-off re-subscribes the stream (the
    // effect keys on streamUrl); the route ignores the query, serving whatever
    // run is currently active.
    streamUrl: `/api/projects/${projectId}/run/stream${
      status ? `?run=${status.runId}` : ""
    }`,
    active: status !== null,
    describe: () => null,
    onEvent: (event) => {
      setStatus((prev) => {
        if (prev === null) {
          return prev;
        }
        switch (event.type) {
          case "item_completed":
            // Absolute from the event's 0-based index, never an increment: the
            // stream replays eventsSoFar() on connect, so incrementing would
            // double-count the items already reflected in the seed snapshot.
            return {
              ...prev,
              completed: Math.max(
                prev.completed,
                (Number(event.index) || 0) + 1,
              ),
            };
          case "run_started":
            return { ...prev, total: Number(event.totalItems) || prev.total };
          case "run_pause_requested":
            return { ...prev, phase: "pausing" };
          case "run_paused":
            return { ...prev, phase: "paused" };
          case "run_resumed":
            return { ...prev, phase: "running" };
          case "run_cancel_requested":
            return { ...prev, phase: "cancelling" };
          default:
            return prev;
        }
      });
    },
    onDone: () => {
      // Don't null the status by hand — that would desync the identity check
      // above. Refresh instead; the server snapshot (now null, or the next
      // run) flows back through the runId comparison and adopts cleanly.
      router.refresh();
    },
  });

  return (
    <RunStatusContext.Provider value={status}>
      {status ? <RunStatusBar projectId={projectId} status={status} /> : null}
      {children}
    </RunStatusContext.Provider>
  );
}

/** The persistent bar: which run is active, its phase, n/m progress, and
 * pause/cancel — on every project page. */
function RunStatusBar({
  projectId,
  status,
}: {
  projectId: string;
  status: ActiveRunStatus;
}) {
  // ActiveRunStatus.phase already excludes the terminal "cancelled", so it is
  // exactly a RunControlPhase.
  const phase: RunControlPhase = status.phase;
  return (
    <div className="sticky top-0 z-20 mb-4 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-sky-900">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-500" />
          <span className="font-medium">{runKindLabel(status.kind)} läuft</span>
          {status.total > 0 ? (
            <span className="text-sky-700">
              · {Math.min(status.completed, status.total)}/{status.total}
            </span>
          ) : null}
        </div>
        {status.kind ? (
          <RunControls projectId={projectId} kind={status.kind} phase={phase} />
        ) : null}
      </div>
    </div>
  );
}
