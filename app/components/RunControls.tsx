"use client";

import { useActionState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import {
  cancelRunAction,
  pauseRunAction,
  resumeRunAction,
  type RunControlFormState,
} from "@/app/lib/run-control-actions";

const initialState: RunControlFormState = { error: null };

const controlButtonClass =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm " +
  "font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";

/** Client-side mirror of the runner's control state, fed by stream events. */
export type RunControlPhase = "running" | "pausing" | "paused" | "cancelling";

/**
 * Pause/resume/cancel buttons of a live run (TMB-50), shared by the three
 * run panels. Cooperative semantics: a request takes effect between items,
 * the in-flight CLI call always finishes — the phase labels make that wait
 * visible instead of pretending an instant stop.
 */
export function RunControls({
  projectId,
  kind,
  phase,
}: {
  projectId: string;
  kind: string;
  phase: RunControlPhase;
}) {
  const [pauseState, pauseAction, pausePending] = useActionState(
    pauseRunAction.bind(null, projectId, kind),
    initialState,
  );
  const [resumeState, resumeAction, resumePending] = useActionState(
    resumeRunAction.bind(null, projectId, kind),
    initialState,
  );
  const [cancelState, cancelAction, cancelPending] = useActionState(
    cancelRunAction.bind(null, projectId, kind),
    initialState,
  );

  const busy = pausePending || resumePending || cancelPending;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {phase === "paused" || phase === "pausing" ? (
          <form action={resumeAction}>
            <button
              type="submit"
              disabled={busy || phase === "pausing"}
              className={controlButtonClass}
            >
              Fortsetzen
            </button>
          </form>
        ) : (
          <form action={pauseAction}>
            <button
              type="submit"
              disabled={busy || phase === "cancelling"}
              className={controlButtonClass}
            >
              Pausieren
            </button>
          </form>
        )}
        <form action={cancelAction}>
          <button
            type="submit"
            disabled={busy || phase === "cancelling"}
            className={controlButtonClass}
          >
            Abbrechen
          </button>
        </form>
        {phase === "pausing" ? (
          <span className="text-xs text-slate-500">
            Pausiert nach dem laufenden Schritt …
          </span>
        ) : null}
        {phase === "paused" ? (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
            Pausiert – kein weiterer Schritt startet
          </span>
        ) : null}
        {phase === "cancelling" ? (
          <span className="text-xs text-slate-500">
            Bricht nach dem laufenden Schritt ab …
          </span>
        ) : null}
      </div>
      <ErrorBanner
        message={pauseState.error ?? resumeState.error ?? cancelState.error}
      />
    </div>
  );
}
