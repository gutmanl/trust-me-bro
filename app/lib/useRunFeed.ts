"use client";

import { useEffect, useRef, useState } from "react";

import { useProjectEvents } from "./ProjectEventStream";

export interface ProgressLine {
  key: number;
  text: string;
}

export interface RunFeedOptions {
  /** Run kind this panel shows ("extraction", "verification", …). */
  kind: string;
  /** The panel believes a run of its kind is live. Gates the side effects
   * (onEvent/onDone); collecting lines is deliberately not gated, see the
   * note on the hook. */
  active: boolean;
  /** Maps a progress event to a display line; null suppresses the line. */
  describe: (event: Record<string, unknown>) => string | null;
  /** Called when a run of this kind reaches its terminal event, and when a
   * connection snapshot shows no run of this kind although the panel is
   * watching one — the place for setStopped/router.refresh(). */
  onDone: () => void;
  /** Optional per-event hook (e.g. refresh durable state on item_completed
   * so inline status markers update while the run continues). */
  onEvent?: (event: Record<string, unknown>) => void;
}

/**
 * A panel's progress feed over the shared project event stream — the
 * successor of useJobStream, which opened one EventSource per panel against
 * one per-feature route (all of which closed on `run_completed`, so an
 * auto-chained follow-up run left the panel watching a dead stream).
 *
 * Two deliberate differences to the old per-panel subscription:
 *
 * - Lines are collected whenever the shared stream carries a run of this
 *   kind, not only while `active`. A run's feed therefore exists from its
 *   first event even if the panel only starts watching mid-run — routine now
 *   that the auto-chain starts runs nobody pressed a button for. `active`
 *   still gates every SIDE EFFECT, so a panel that is not watching never
 *   refreshes the page behind the user's back.
 * - Lines reset on a run boundary (a new runId) and on a reconnect (a fresh
 *   connection snapshot, whose replay rebuilds the feed) instead of on the
 *   `active` flip. Same visible effect — a new run starts with an empty feed
 *   — without depending on when the panel decided to watch.
 */
export function useRunFeed(options: RunFeedOptions): {
  lines: ProgressLine[];
  /** The stream is down — the feed has gone silent not because the run
   * ended but because the connection was lost. The durable state is intact
   * server-side, so a reload recovers it. */
  connectionLost: boolean;
} {
  // Callbacks travel through a ref so nothing depends on callers memoizing
  // their closures.
  const callbacks = useRef(options);
  useEffect(() => {
    callbacks.current = options;
  });

  const [lines, setLines] = useState<ProgressLine[]>([]);
  const counter = useRef(0);
  const feedRunId = useRef<string | null>(null);

  const { connectionLost } = useProjectEvents(
    { kind: options.kind },
    (envelope) => {
      if (feedRunId.current !== envelope.runId) {
        // A different run than the one the feed currently shows: start over.
        feedRunId.current = envelope.runId;
        counter.current = 0;
        setLines([]);
      }
      const { active, describe, onDone, onEvent } = callbacks.current;
      if (active) {
        onEvent?.(envelope.event);
      }
      const text = describe(envelope.event);
      if (text !== null) {
        counter.current += 1;
        const line = { key: counter.current, text };
        setLines((previous) => [...previous, line]);
      }
      if (
        active &&
        (envelope.event.type === "run_completed" ||
          envelope.event.type === "run_cancelled")
      ) {
        onDone();
      }
    },
    (snapshotRun) => {
      // Connection snapshot — the authority on what is running right now.
      // It arrives immediately before the active run's events are (re)played,
      // so the feed starts over from that replay instead of keeping a copy.
      counter.current = 0;
      feedRunId.current = null;
      setLines([]);
      // "The run I am watching does not exist (any more)": `active` comes
      // from durable state, which can outlive the runner's memory (a server
      // restart, a crashed run) or be stale by the time a panel mounts. The
      // old per-feature streams un-stuck the panel with their `state` event;
      // this is that path.
      const { active, kind, onDone } = callbacks.current;
      if (active && snapshotRun?.kind !== kind) {
        onDone();
      }
    },
  );

  return { lines, connectionLost };
}
