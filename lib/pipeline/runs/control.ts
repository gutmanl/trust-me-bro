import { NoActiveRunError } from "../errors";
import { getGlobalJobRunner } from "./job-runner";
import type { JobRunner } from "./job-runner";

/**
 * Run control use-cases (TMB-50), generic across run kinds — extraction,
 * verification and relevance share one implementation. Pause and cancel are
 * cooperative (between items, never interrupting an in-flight CLI call);
 * a cancelled verification/relevance run leaves a dangling register bracket
 * that the existing "unterbrochen" recovery of the next start sweeps up —
 * cancellation is therefore never data loss.
 */

function requireActiveRun(
  projectId: string,
  kind: string,
  deps: { runner?: JobRunner },
) {
  const runner = deps.runner ?? getGlobalJobRunner();
  const run = runner.currentRun(projectId, kind);
  if (!run || !run.isActive()) {
    throw new NoActiveRunError(projectId);
  }
  return run;
}

/** Requests a pause before the next item; idempotent while pausing/paused. */
export function pauseRun(
  projectId: string,
  kind: string,
  deps: { runner?: JobRunner } = {},
): void {
  requireActiveRun(projectId, kind, deps).requestPause();
}

/** Releases a pending or effective pause; idempotent while running. */
export function resumeRun(
  projectId: string,
  kind: string,
  deps: { runner?: JobRunner } = {},
): void {
  requireActiveRun(projectId, kind, deps).resume();
}

/** Requests cancellation before the next item; idempotent while cancelling. */
export function cancelRun(
  projectId: string,
  kind: string,
  deps: { runner?: JobRunner } = {},
): void {
  requireActiveRun(projectId, kind, deps).requestCancel();
}
