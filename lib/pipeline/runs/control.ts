import { NoActiveRunError } from "../errors";
import { getGlobalActivityLedger } from "./activity-ledger";
import type { ActivityLedger } from "./activity-ledger";
import { getGlobalJobRunner } from "./job-runner";
import type { JobRunner } from "./job-runner";
import { formatActivitySince } from "./labels";

/**
 * Run control use-cases (TMB-50), generic across run kinds — extraction,
 * verification and relevance share one implementation. Pause is cooperative
 * (between items, never interrupting an in-flight CLI call); cancel abandons
 * the in-flight step since the run-visibility work — the run finalizes
 * immediately, the step settles in the background, and a cancelled
 * verification/relevance run leaves a dangling register bracket that the
 * existing "interrupted" recovery of the next start sweeps up — cancellation
 * is therefore never data loss.
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

/** Requests cancellation; since the run-visibility work this abandons an
 * in-flight item rather than waiting for it. Idempotent while cancelling. */
export function cancelRun(
  projectId: string,
  kind: string,
  deps: { runner?: JobRunner } = {},
): void {
  requireActiveRun(projectId, kind, deps).requestCancel();
}

/**
 * Cancels whatever currently occupies the project's single-writer seat — a
 * run or an off-runner chain trigger — uniformly (run visibility). The one
 * cancel the status bar needs: the user never has to know which machine
 * their blocker lives on.
 */
export function cancelActivity(
  projectId: string,
  deps: { ledger?: ActivityLedger } = {},
): void {
  const entry = (deps.ledger ?? getGlobalActivityLedger()).current(projectId);
  if (!entry) {
    throw new NoActiveRunError(projectId);
  }
  entry.requestCancel();
}

/**
 * The current occupant's German description and start time, for
 * blocked-action messages ("Für Projekt läuft bereits: … (seit …)") — the
 * refusal must name what blocks, or the user is stopped by work they
 * cannot see (run visibility). Undefined when the seat is free.
 */
export function describeBlockingActivity(
  projectId: string,
  deps: { ledger?: ActivityLedger } = {},
): { description: string; since: string } | undefined {
  const entry = (deps.ledger ?? getGlobalActivityLedger()).current(projectId);
  if (!entry) {
    return undefined;
  }
  return {
    description: entry.description,
    since: formatActivitySince(entry.startedAt),
  };
}
