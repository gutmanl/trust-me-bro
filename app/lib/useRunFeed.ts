"use client";

import { useEffect, useRef, useState } from "react";

import { useProjectEvents } from "./ProjectEventStream";

export interface ProgressLine {
  key: number;
  text: string;
}

/**
 * Remembers that a run of the panel's kind has ended, so its `onDone` is
 * still delivered when the panel only starts watching AFTERWARDS.
 *
 * Why this is not just "fire onDone on the terminal event": a panel becomes
 * `watching` from its start action's response, and a short run can be over
 * before that response commits — reference capture in particular finishes a
 * cached or instantly-failing batch in milliseconds. The panel then flips to
 * "Wird erfasst …" with the terminal event already behind it and nothing
 * left to end it: stuck until a manual reload. The per-feature capture route
 * papered over this by replaying the finished run's log; the unified stream
 * follows only live runs, so the latch belongs here.
 *
 * Terminal events are latched per run, and each latched run is reported at
 * most once, so an `active` flag that flips back and forth cannot re-fire a
 * run's completion.
 *
 * The latch therefore has to know which run the panel is currently following,
 * not only which one ended. `active` can flip true for reasons that have
 * nothing to do with the latched run — any terminal envelope of any kind
 * triggers a `router.refresh()`, which can re-render a panel into `watching`
 * while a LATER run of its kind is mid-flight. Paying a stale run's `onDone`
 * then would flash "done" in the middle of a running run and fire a second
 * time when that run really ends. So the debt is settled only while the
 * latched run is still the most recent one the panel has seen anything from.
 */
export interface RunDoneLatch {
  /** Records that a run of the panel's kind produced an envelope — the
   * latch's notion of "the run the panel is currently following". */
  observed(runId: string): void;
  /** Records a run's terminal event. Returns whether `onDone` must fire now
   * — i.e. the panel is watching and has not been told about this run yet. */
  terminated(runId: string, active: boolean): boolean;
  /** Called when the panel's `active` flag settles. Returns whether a
   * latched terminal event still owes this panel its `onDone`. */
  watched(active: boolean): boolean;
}

export function createRunDoneLatch(): RunDoneLatch {
  let lastSeenRunId: string | null = null;
  let terminatedRunId: string | null = null;
  let notifiedRunId: string | null = null;
  const owed = (active: boolean): boolean =>
    active && terminatedRunId !== null && terminatedRunId !== notifiedRunId;
  return {
    observed(runId) {
      lastSeenRunId = runId;
    },
    terminated(runId, active) {
      lastSeenRunId = runId;
      terminatedRunId = runId;
      if (!owed(active)) {
        return false;
      }
      notifiedRunId = runId;
      return true;
    },
    watched(active) {
      // A newer run has since produced envelopes: the latched completion is
      // moot. The panel is following that run and its own terminal event
      // will fire normally — no need to mark the stale debt settled, it can
      // never come due again.
      if (!owed(active) || terminatedRunId !== lastSeenRunId) {
        return false;
      }
      notifiedRunId = terminatedRunId;
      return true;
    },
  };
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
  // useState, not useRef: the latch must be readable during render (it is
  // handed to the effect below), which the refs lint rule rightly forbids.
  // The lazy initializer keeps it stable for the panel's lifetime.
  const [latch] = useState(createRunDoneLatch);

  const { connectionLost } = useProjectEvents(
    { kind: options.kind },
    (envelope) => {
      if (envelope.source !== "run") {
        // Panel feeds follow runner runs; the off-runner trigger kinds are
        // disjoint from every panel's kind, so nothing is lost here.
        return;
      }
      // Before anything else: this is the run the panel is now following, so
      // a completion latched for an earlier run can no longer come due.
      latch.observed(envelope.runId);
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
        envelope.event.type === "run_completed" ||
        envelope.event.type === "run_cancelled"
      ) {
        // Latched even while the panel is not watching yet: a short run can
        // end before the start action's response makes `active` true.
        if (latch.terminated(envelope.runId, active)) {
          onDone();
        }
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

  // The other half of the latch: the panel started watching a run that is
  // already over. Declared AFTER useProjectEvents so a subscriber mounting
  // into a live stream has replayed first — a run whose terminal event is
  // delivered during that replay reports through the handler above, not
  // twice.
  useEffect(() => {
    if (latch.watched(options.active)) {
      callbacks.current.onDone();
    }
  }, [latch, options.active]);

  return { lines, connectionLost };
}
