/** Progress vocabulary of the in-process job runner (TMB-25; TMB-4's stage
 * runs reuse it with one item per claim instead of one per briefing). */

export interface RunItemOutcome<TResult = unknown> {
  itemId: string;
  status: "ok" | "error";
  result?: TResult;
  error?: string;
}

/**
 * Control state of a run. Pause is cooperative (TMB-50): it takes effect
 * BETWEEN items, so an in-flight CLI call is never interrupted, and
 * "pausing" is the requested-but-not-yet-effective phase while the current
 * item finishes. Cancel is stronger since the run-visibility work: it
 * ABANDONS the in-flight item — the run finalizes immediately and the
 * item's step settles in the background as a tracked zombie — so
 * "cancelling" is only ever the instant before "cancelled", kept as its own
 * phase for the request/effect event pair.
 */
export type RunControlState =
  "running" | "pausing" | "paused" | "cancelling" | "cancelled";

export type RunProgressEvent<TResult = unknown> =
  | {
      type: "run_started";
      runId: string;
      projectId: string;
      totalItems: number;
      /** ISO submission time, mirrored from the handle so a client adopting
       * the run from a live event needs no second source of truth (run
       * visibility; trigger_started carries the same). */
      startedAt: string;
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
  /** ISO submission time — the "läuft seit" the status surface and
   * blocked-action messages show (run visibility). */
  readonly startedAt: string;
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

/**
 * The auto-chain steps that run BETWEEN runner runs, submitting no run of
 * their own (run visibility). Kept off the runner deliberately — the
 * briefing substitution publishes a revision, and `publishBriefingRevision`
 * is guarded by `isRunning`, so modelling these as runs would deadlock the
 * substitution against itself. They get their own handle instead, shaped
 * after RunHandle so the status surface and the event stream treat both
 * uniformly.
 */
export type OffRunnerTriggerKind =
  | "capture_failure_repair"
  | "source_repair_evaluation"
  | "anchor_repair"
  | "briefing_substitution";

/** Progress vocabulary of an off-runner trigger — the RunProgressEvent
 * shape one level down: a trigger has no items and no pause, so the
 * lifecycle is start → (cancel requested →) completed/cancelled. */
export type TriggerProgressEvent =
  | {
      type: "trigger_started";
      triggerId: string;
      projectId: string;
      kind: OffRunnerTriggerKind;
      description: string;
      startedAt: string;
    }
  | { type: "trigger_cancel_requested"; triggerId: string }
  | { type: "trigger_completed"; triggerId: string }
  | { type: "trigger_cancelled"; triggerId: string };

/**
 * Live handle of an off-runner trigger, mirroring RunHandle so the SSE
 * layer's attach discipline (replay `eventsSoFar`, subscribe before
 * reading current) works identically for both.
 */
export interface TriggerHandle {
  readonly triggerId: string;
  readonly projectId: string;
  readonly kind: OffRunnerTriggerKind;
  /** German, per-instance (may name a source) — precomputed by the chain
   * because a static client-side label map cannot know the target. */
  readonly description: string;
  readonly startedAt: string;
  isActive(): boolean;
  eventsSoFar(): TriggerProgressEvent[];
  subscribe(listener: (event: TriggerProgressEvent) => void): () => void;
  controlState(): "running" | "cancelling";
  requestCancel(): boolean;
  /** Settles when the trigger finishes or is abandoned; never rejects. */
  readonly done: Promise<void>;
}
