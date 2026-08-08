/**
 * Pure reducer of the casual effort measurement (TMB-36, `decision.duration_s`).
 *
 * Documented measurement rule: the clock runs while a claim is selected in
 * the panel and the document is visible; it pauses when the tab is hidden
 * and after {@link IDLE_THRESHOLD_MS} without input activity — of any longer
 * gap, at most the threshold is counted. Switching claims restarts the
 * measurement (no cross-claim pause stack: the measure is deliberately
 * casual, not audit-grade). The DOM wiring lives in the review workspace's
 * hook; this reducer is the testable core.
 */

export const IDLE_THRESHOLD_MS = 30_000;

export type EffortEvent =
  | { type: "activity"; at: number }
  | { type: "hidden"; at: number }
  | { type: "visible"; at: number }
  | { type: "tick"; at: number };

export interface EffortState {
  accumulatedMs: number;
  running: boolean;
  lastEventAt: number;
}

export function startEffort(at: number): EffortState {
  return { accumulatedMs: 0, running: true, lastEventAt: at };
}

export function effortReducer(
  state: EffortState,
  event: EffortEvent,
  idleThresholdMs: number = IDLE_THRESHOLD_MS,
): EffortState {
  const elapsed = Math.max(0, event.at - state.lastEventAt);
  const counted = state.running ? Math.min(elapsed, idleThresholdMs) : 0;
  switch (event.type) {
    case "activity":
    case "tick":
      return {
        accumulatedMs: state.accumulatedMs + counted,
        running: state.running,
        lastEventAt: event.at,
      };
    case "hidden":
      return {
        accumulatedMs: state.accumulatedMs + counted,
        running: false,
        lastEventAt: event.at,
      };
    case "visible":
      return {
        accumulatedMs: state.accumulatedMs + counted,
        running: true,
        lastEventAt: event.at,
      };
  }
}

/** Final read at submit time: closes the open interval and rounds. */
export function effortSeconds(state: EffortState, at: number): number {
  const closed = effortReducer(state, { type: "tick", at });
  return Math.round(closed.accumulatedMs / 1000);
}
