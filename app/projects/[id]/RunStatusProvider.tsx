"use client";

import {
  RunControls,
  type RunControlPhase,
} from "@/app/components/RunControls";
import { useProjectEvents } from "@/app/lib/ProjectEventStream";
import type { ActiveRunStatus } from "@/lib/pipeline";

/** German labels for the runner's kinds, for the status bar and the gating
 * notes. Unknown kinds fall back to a neutral word rather than leaking the
 * internal token. */
const RUN_KIND_LABELS: Record<string, string> = {
  extraction: "Extraktion",
  verification: "Prüflauf",
  reference_scan: "Referenz-Scan",
  source_capture: "Quellenerfassung",
  research: "Recherche",
  relevance: "Relevanzprüfung",
  existence_check: "Existenzprüfung",
};

export function runKindLabel(kind: string | null): string {
  return (kind && RUN_KIND_LABELS[kind]) || "Lauf";
}

/** The project's active run, or null. Consumed by the status bar and by every
 * start button (via useStartGate). Reads the shared project event stream —
 * the one place that reconciles the server snapshot with live progress. */
export function useRunStatus(): ActiveRunStatus | null {
  return useProjectEvents().activeRun;
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
 * (runner UI): the sticky bar plus the start-gating every panel reads.
 *
 * Since the workbench epic's unified event stream this is a pure CONSUMER —
 * the snapshot reconciliation (adopt the server's run identity, follow live
 * progress, adopt a run the auto-chain started without a page refresh) lives
 * once in ProjectEventStreamProvider, which the project layout wraps around
 * this component. The public API here — useRunStatus, useStartGate,
 * StartBlockedNotice, the bar itself — is unchanged.
 */
export function RunStatusProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const status = useRunStatus();

  return (
    <>
      {status ? <RunStatusBar projectId={projectId} status={status} /> : null}
      {children}
    </>
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
