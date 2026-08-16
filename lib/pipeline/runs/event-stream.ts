import { getGlobalAutoChain } from "./auto-chain";
import type { AutoChain } from "./auto-chain";
import { getGlobalJobRunner } from "./job-runner";
import type { JobRunner } from "./job-runner";
import { getActiveRunHandle } from "./status";
import type {
  OffRunnerTriggerKind,
  RunHandle,
  RunProgressEvent,
  TriggerHandle,
  TriggerProgressEvent,
} from "./types";

/**
 * One progress event of one run, tagged with the run it belongs to — the
 * unit the unified per-project event stream ships. A client that follows a
 * whole project (instead of one run of one kind, as the seven per-feature
 * streams did) needs both tags to route an event: `kind` to decide which
 * panel it belongs to, `runId` to tell one run from its successor.
 */
export type ProjectRunEnvelope =
  | {
      source: "run";
      kind: string | null;
      runId: string;
      event: RunProgressEvent;
    }
  | {
      source: "trigger";
      kind: OffRunnerTriggerKind;
      triggerId: string;
      event: TriggerProgressEvent;
    };

/** Run starts of ONE project. The runner announces every run process-wide;
 * this is the project filter the SSE route needs, so the runner itself stays
 * internal to the pipeline layer. */
export function subscribeProjectRunStarts(
  projectId: string,
  listener: (handle: RunHandle) => void,
  deps: { runner?: JobRunner } = {},
): () => void {
  const runner = deps.runner ?? getGlobalJobRunner();
  return runner.subscribeRunStarts((handle) => {
    if (handle.projectId === projectId) {
      listener(handle);
    }
  });
}

/**
 * Follows EVERY run of a project — the one that is already active plus every
 * run that starts later — until the caller unsubscribes. This is the server
 * half of the unified event stream (workbench epic): the per-feature streams
 * it replaces closed on `run_completed`, so an auto-chained follow-up run
 * left the connected client watching a stream that had gone silent for good.
 *
 * Two ordering guarantees make the attach lossless, both resting on the fact
 * that the runner emits synchronously and this function never awaits:
 *
 * 1. `submit()` emits `run_started` (and the first `item_started`) BEFORE it
 *    announces the run, so attaching replays `eventsSoFar()` first and only
 *    then subscribes. Replay and subscription happen in the same synchronous
 *    turn, so they partition the event log exactly — no gap, no duplicate.
 * 2. The run-start subscription is installed BEFORE the currently active run
 *    is attached, so a run cannot slip through in between. The runId ledger
 *    below makes attaching the same run twice a no-op, which is what allows
 *    that order without risking a doubled replay.
 */
export function streamProjectRunEvents(
  projectId: string,
  onEnvelope: (envelope: ProjectRunEnvelope) => void,
  deps: { runner?: JobRunner; chain?: AutoChain } = {},
): () => void {
  const runner = deps.runner ?? getGlobalJobRunner();
  const chain = deps.chain ?? getGlobalAutoChain();
  /** Runs already attached (live subscription) — also the dedupe ledger. */
  const following = new Map<string, () => void>();
  /** Every runId ever attached, including finished ones: a tombstone keeps a
   * late duplicate attach from replaying a completed run's log again. */
  const attached = new Set<string>();

  const attach = (handle: RunHandle): void => {
    if (attached.has(handle.runId)) {
      return;
    }
    attached.add(handle.runId);
    const send = (event: RunProgressEvent): void => {
      onEnvelope({
        source: "run",
        kind: handle.kind ?? null,
        runId: handle.runId,
        event,
      });
    };
    // No await between these two — see the ordering guarantees above.
    for (const event of handle.eventsSoFar()) {
      send(event);
    }
    if (!handle.isActive()) {
      // The replay already carried the terminal event; nothing more will
      // come, so there is nothing to subscribe to.
      return;
    }
    const unsubscribe = handle.subscribe((event) => {
      send(event);
      if (event.type === "run_completed" || event.type === "run_cancelled") {
        // The RUN is over, the STREAM is not: drop only this run's listener
        // and keep waiting for the next run of the project.
        following.get(handle.runId)?.();
        following.delete(handle.runId);
      }
    });
    following.set(handle.runId, unsubscribe);
  };

  // The chain's off-runner triggers, attached with the IDENTICAL replay-
  // then-subscribe discipline (run visibility): a client that connects
  // mid-trigger must see it, exactly as it sees a mid-flight run — this is
  // the capture-run-visibility precedent applied to the second half of the
  // project's activity.
  const attachTrigger = (handle: TriggerHandle): void => {
    if (attached.has(handle.triggerId)) {
      return;
    }
    attached.add(handle.triggerId);
    const send = (event: TriggerProgressEvent): void => {
      onEnvelope({
        source: "trigger",
        kind: handle.kind,
        triggerId: handle.triggerId,
        event,
      });
    };
    for (const event of handle.eventsSoFar()) {
      send(event);
    }
    if (!handle.isActive()) {
      return;
    }
    const unsubscribe = handle.subscribe((event) => {
      send(event);
      if (
        event.type === "trigger_completed" ||
        event.type === "trigger_cancelled"
      ) {
        following.get(handle.triggerId)?.();
        following.delete(handle.triggerId);
      }
    });
    following.set(handle.triggerId, unsubscribe);
  };

  const unsubscribeStarts = subscribeProjectRunStarts(projectId, attach, {
    runner,
  });
  const unsubscribeTriggerStarts = chain.subscribeTriggerStarts((handle) => {
    if (handle.projectId === projectId) {
      attachTrigger(handle);
    }
  });
  const active = getActiveRunHandle(projectId, { runner });
  if (active) {
    attach(active);
  }
  const activeTrigger = chain.activeTrigger(projectId);
  if (activeTrigger) {
    attachTrigger(activeTrigger);
  }

  return () => {
    unsubscribeStarts();
    unsubscribeTriggerStarts();
    for (const unsubscribe of following.values()) {
      unsubscribe();
    }
    following.clear();
  };
}
