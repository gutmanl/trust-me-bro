import { randomUUID } from "node:crypto";

import { RunActiveError } from "../errors";
import type {
  RunControlState,
  RunHandle,
  RunItemOutcome,
  RunProgressEvent,
} from "./types";

/**
 * Minimal in-process job runner (TMB-25, Grobentwurf): per project at most
 * one active run — that preserves the single-writer invariant without a
 * queue —, cross-project runs are naturally concurrent up to the adapter
 * layer's global CLI gate. Progress lives in memory only; the durable truth
 * (batch events, claim statuses) is always in the register, so a server
 * restart loses nothing but the live progress feed.
 *
 * Runs carry an optional `kind` ("extraction", "verification"): exclusivity
 * stays project-wide across kinds (single writer), but each feature's state
 * derivation and SSE stream can address ITS runs — without the kind filter,
 * the extraction page would replay a verification run and vice versa.
 *
 * TMB-50 adds cooperative pause/cancel: both take effect BETWEEN items (an
 * in-flight CLI call is never interrupted), pause blocks the loop on an
 * internal gate the resume releases, cancel ends the loop early with a
 * run_cancelled terminal event. Because every finished item committed
 * durably, a cancelled run is never data loss — resuming is starting a new
 * run, exactly like after a rate-limit pause or a crash.
 */

export interface JobRunner {
  isRunning(projectId: string, kind?: string): boolean;
  /** The active run, or the most recently finished one (for late viewers);
   * with `kind`, both are filtered to runs of that kind. */
  currentRun(projectId: string, kind?: string): RunHandle | undefined;
  submit<TItem, TResult>(
    projectId: string,
    items: readonly TItem[],
    itemId: (item: TItem) => string,
    step: (item: TItem, context: { runId: string }) => Promise<TResult>,
    options?: { kind?: string },
  ): RunHandle<TResult>;
}

const lastKey = (projectId: string, kind: string): string =>
  `${projectId}\n${kind}`;

export function createJobRunner(options?: {
  generateRunId?: () => string;
}): JobRunner {
  const generateRunId = options?.generateRunId ?? randomUUID;
  const active = new Map<string, RunHandle>();
  const last = new Map<string, RunHandle>();

  return {
    isRunning(projectId, kind) {
      const run = active.get(projectId);
      return run !== undefined && (kind === undefined || run.kind === kind);
    },
    currentRun(projectId, kind) {
      const activeRun = active.get(projectId);
      if (activeRun && (kind === undefined || activeRun.kind === kind)) {
        return activeRun;
      }
      return last.get(
        kind === undefined ? projectId : lastKey(projectId, kind),
      );
    },
    submit<TItem, TResult>(
      projectId: string,
      items: readonly TItem[],
      itemId: (item: TItem) => string,
      step: (item: TItem, context: { runId: string }) => Promise<TResult>,
      submitOptions?: { kind?: string },
    ): RunHandle<TResult> {
      if (active.has(projectId)) {
        throw new RunActiveError(projectId);
      }
      const runId = generateRunId();
      const kind = submitOptions?.kind;
      const events: RunProgressEvent<TResult>[] = [];
      const listeners = new Set<(event: RunProgressEvent<TResult>) => void>();
      let activeFlag = true;
      let controlState: RunControlState = "running";
      let pauseGate: { promise: Promise<void>; resolve: () => void } | null =
        null;

      const emit = (event: RunProgressEvent<TResult>): void => {
        events.push(event);
        for (const listener of listeners) {
          listener(event);
        }
      };

      const armPauseGate = (): void => {
        let release!: () => void;
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });
        pauseGate = { promise, resolve: release };
      };

      // Accessor helpers: the loop reads state that closures (the handle's
      // control methods) mutate across awaits — TS narrowing cannot see
      // those assignments, function calls return the unnarrowed type.
      const isCancelRequested = (): boolean => controlState === "cancelling";
      const armedGate = (): { promise: Promise<void> } | null => pauseGate;

      const done = (async () => {
        emit({
          type: "run_started",
          runId,
          projectId,
          totalItems: items.length,
        });
        let succeeded = 0;
        let failed = 0;
        for (const [index, item] of items.entries()) {
          if (isCancelRequested()) {
            break;
          }
          const gate = armedGate();
          if (gate !== null) {
            controlState = "paused";
            emit({ type: "run_paused", runId });
            await gate.promise;
            if (isCancelRequested()) {
              break;
            }
          }
          const id = itemId(item);
          emit({ type: "item_started", runId, itemId: id, index });
          let outcome: RunItemOutcome<TResult>;
          try {
            outcome = {
              itemId: id,
              status: "ok",
              result: await step(item, { runId }),
            };
            succeeded += 1;
          } catch (error) {
            outcome = {
              itemId: id,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            };
            failed += 1;
          }
          emit({ type: "item_completed", runId, itemId: id, index, outcome });
        }
        activeFlag = false;
        active.delete(projectId);
        if (isCancelRequested()) {
          controlState = "cancelled";
          emit({ type: "run_cancelled", runId, projectId, succeeded, failed });
        } else {
          controlState = "running";
          emit({ type: "run_completed", runId, projectId, succeeded, failed });
        }
        return { succeeded, failed };
      })();

      const handle: RunHandle<TResult> = {
        runId,
        projectId,
        kind,
        isActive: () => activeFlag,
        eventsSoFar: () => [...events],
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        controlState: () => controlState,
        requestPause() {
          if (!activeFlag || controlState !== "running") {
            return false;
          }
          controlState = "pausing";
          armPauseGate();
          emit({ type: "run_pause_requested", runId });
          return true;
        },
        resume() {
          if (
            !activeFlag ||
            (controlState !== "pausing" && controlState !== "paused")
          ) {
            return false;
          }
          const wasBlocked = controlState === "paused";
          controlState = "running";
          pauseGate?.resolve();
          pauseGate = null;
          if (wasBlocked) {
            emit({ type: "run_resumed", runId });
          }
          return true;
        },
        requestCancel() {
          if (
            !activeFlag ||
            controlState === "cancelling" ||
            controlState === "cancelled"
          ) {
            return false;
          }
          controlState = "cancelling";
          emit({ type: "run_cancel_requested", runId });
          // A pending pause must not deadlock the cancel: release the gate,
          // the loop wakes up and exits before the next item.
          pauseGate?.resolve();
          pauseGate = null;
          return true;
        },
        done,
      };
      active.set(projectId, handle);
      last.set(projectId, handle);
      if (kind !== undefined) {
        last.set(lastKey(projectId, kind), handle);
      }
      return handle;
    },
  };
}

/** Process-global runner, mirroring the adapter layer's global gate. */
let globalRunner: JobRunner | undefined;

export function getGlobalJobRunner(): JobRunner {
  globalRunner ??= createJobRunner();
  return globalRunner;
}
