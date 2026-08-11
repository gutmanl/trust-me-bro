import { getGlobalJobRunner } from "./job-runner";
import type { JobRunner } from "./job-runner";
import type { RunControlState, RunHandle } from "./types";

/**
 * Project-level view of the runner (TMB runner UI): the single source of
 * truth the shared status bar and the global start-gating read, so every
 * page agrees on "what is running for this project" instead of each panel
 * guessing from its own kind. The runner is single-writer per project, so
 * there is at most one such run.
 */
export interface ActiveRunStatus {
  /** Feature the run belongs to ("extraction", "reference_capture", …); null
   * for the rare kind-less run. The UI maps it to a German label. */
  kind: string | null;
  /** Cooperative control phase — an active run is never "cancelled" (that is
   * the terminal state), so in practice one of running/pausing/paused/
   * cancelling. */
  phase: RunControlState;
  /** Items whose outcome is in, and the batch size, for an n/m progress
   * readout. total is 0 until the run_started event is observed. */
  completed: number;
  total: number;
}

/** The live run handle for a project, any kind — the project-level twin of
 * the per-kind getXRun accessors, for the kind-agnostic status stream. */
export function getActiveRunHandle(
  projectId: string,
  deps: { runner?: JobRunner } = {},
): RunHandle | undefined {
  const run = (deps.runner ?? getGlobalJobRunner()).currentRun(projectId);
  return run?.isActive() ? run : undefined;
}

/** A snapshot of the project's active run, or null when nothing is running —
 * derived purely from the runner's in-memory event log and control state. */
export function getActiveRun(
  projectId: string,
  deps: { runner?: JobRunner } = {},
): ActiveRunStatus | null {
  const run = getActiveRunHandle(projectId, deps);
  if (!run) {
    return null;
  }
  const events = run.eventsSoFar();
  const started = events.find((event) => event.type === "run_started");
  return {
    kind: run.kind ?? null,
    phase: run.controlState(),
    completed: events.filter((event) => event.type === "item_completed").length,
    total: started?.type === "run_started" ? started.totalItems : 0,
  };
}
