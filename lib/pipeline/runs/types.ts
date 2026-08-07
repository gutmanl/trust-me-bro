/** Progress vocabulary of the in-process job runner (TMB-25; TMB-4's stage
 * runs reuse it with one item per claim instead of one per briefing). */

export interface RunItemOutcome<TResult = unknown> {
  itemId: string;
  status: "ok" | "error";
  result?: TResult;
  error?: string;
}

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
  /** True until run_completed was emitted. */
  isActive(): boolean;
  /** All events so far — replayed to late subscribers (SSE reconnect). */
  eventsSoFar(): RunProgressEvent<TResult>[];
  /** Subscribes to future events; returns the unsubscribe function. */
  subscribe(listener: (event: RunProgressEvent<TResult>) => void): () => void;
  /** Resolves with the final counts; never rejects. */
  readonly done: Promise<{ succeeded: number; failed: number }>;
}
