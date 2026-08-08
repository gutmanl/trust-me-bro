/** Progress vocabulary of the in-process job runner (TMB-25; TMB-4's stage
 * runs reuse it with one item per claim instead of one per briefing). */

export interface RunItemOutcome<TResult = unknown> {
  itemId: string;
  status: "ok" | "error";
  result?: TResult;
  error?: string;
}

/**
 * Cooperative control state of a run (TMB-50): user-initiated pause/cancel
 * takes effect BETWEEN items — an in-flight CLI call is never interrupted
 * (same discipline as the timeout/rate-limit handling). "pausing" and
 * "cancelling" are the requested-but-not-yet-effective phases while the
 * current item finishes.
 */
export type RunControlState =
  "running" | "pausing" | "paused" | "cancelling" | "cancelled";

export type RunProgressEvent<TResult = unknown> =
  | {
      type: "run_started";
      runId: string;
      projectId: string;
      totalItems: number;
    }
  | { type: "item_started"; runId: string; itemId: string; index: number }
  | {
      type: "item_completed";
      runId: string;
      itemId: string;
      index: number;
      outcome: RunItemOutcome<TResult>;
    }
  // TMB-50: pause/cancel lifecycle. run_paused/run_resumed mark the moments
  // the loop actually blocks/continues; the *_requested events give instant
  // feedback while an item is still in flight.
  | { type: "run_pause_requested"; runId: string }
  | { type: "run_paused"; runId: string }
  | { type: "run_resumed"; runId: string }
  | { type: "run_cancel_requested"; runId: string }
  | {
      type: "run_cancelled";
      runId: string;
      projectId: string;
      succeeded: number;
      failed: number;
    }
  | {
      type: "run_completed";
      runId: string;
      projectId: string;
      succeeded: number;
      failed: number;
    };

export interface RunHandle<TResult = unknown> {
  readonly runId: string;
  readonly projectId: string;
  /** Feature that started the run ("extraction", "verification"); lets each
   * feature address its own runs on the shared per-project runner. */
  readonly kind?: string;
  /** True until the terminal event (run_completed or run_cancelled). */
  isActive(): boolean;
  /** All events so far — replayed to late subscribers (SSE reconnect). */
  eventsSoFar(): RunProgressEvent<TResult>[];
  /** Subscribes to future events; returns the unsubscribe function. */
  subscribe(listener: (event: RunProgressEvent<TResult>) => void): () => void;
  /** TMB-50: cooperative control. The request methods return false when the
   * run is not in a state that accepts the request (idempotent clicking). */
  controlState(): RunControlState;
  requestPause(): boolean;
  resume(): boolean;
  requestCancel(): boolean;
  /** Resolves with the final counts; never rejects. */
  readonly done: Promise<{ succeeded: number; failed: number }>;
}
