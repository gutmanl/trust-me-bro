"use client";

import { useEffect, useRef, useState } from "react";

export interface ProgressLine {
  key: number;
  text: string;
}

export interface JobStreamOptions {
  /** SSE endpoint of the run (extraction/verification stream route). */
  streamUrl: string;
  /** Subscribe while true; lines reset on every new subscription. */
  active: boolean;
  /** Maps a progress event to a display line; null suppresses the line. */
  describe: (event: Record<string, unknown>) => string | null;
  /** Called once when the run completes or only a state snapshot exists —
   * the place for setStopped/router.refresh(). */
  onDone: () => void;
  /** Optional per-event hook (e.g. refresh durable state on item_completed
   * so inline status markers update while the run continues). */
  onEvent?: (event: Record<string, unknown>) => void;
}

/**
 * Shared SSE subscription of the run panels (TMB-5): the third consumer
 * made the extraction/verification twin duplication indefensible, so the
 * EventSource lifecycle lives here once. Durable state stays server-rendered;
 * this hook only carries the volatile progress feed.
 */
export function useJobStream(options: JobStreamOptions): {
  lines: ProgressLine[];
  /** The stream dropped before the run finished — the feed has gone silent
   * not because the run ended but because the connection was lost. Distinct
   * from a clean completion so the UI can tell the user to reload. */
  connectionLost: boolean;
} {
  const { streamUrl, active } = options;
  // Callbacks travel through a ref so effect re-subscription depends only on
  // active/streamUrl, not on callers memoizing their closures.
  const callbacks = useRef(options);
  useEffect(() => {
    callbacks.current = options;
  });
  const [lines, setLines] = useState<ProgressLine[]>([]);
  const [connectionLost, setConnectionLost] = useState(false);

  // Render-phase state adjustment (established panel idiom): a fresh
  // subscription starts with an empty feed and no lost-connection flag.
  const [lastActive, setLastActive] = useState(active);
  if (active !== lastActive) {
    setLastActive(active);
    if (active) {
      setLines([]);
      setConnectionLost(false);
    }
  }

  useEffect(() => {
    if (!active) {
      return;
    }
    const source = new EventSource(streamUrl);
    let counter = 0;
    let finished = false;
    const finish = (): void => {
      finished = true;
      source.close();
      callbacks.current.onDone();
    };
    source.addEventListener("progress", (event) => {
      const parsed = JSON.parse((event as MessageEvent).data) as Record<
        string,
        unknown
      >;
      callbacks.current.onEvent?.(parsed);
      const text = callbacks.current.describe(parsed);
      if (text) {
        counter += 1;
        const line = { key: counter, text };
        setLines((previous) => [...previous, line]);
      }
      if (parsed.type === "run_completed" || parsed.type === "run_cancelled") {
        finish();
      }
    });
    source.addEventListener("state", () => {
      // No live run (e.g. page load after completion): the server-rendered
      // state is already current; just stop streaming.
      finish();
    });
    source.onerror = () => {
      // A drop AFTER a clean finish is just the closed socket; a drop while
      // the run is still live is a real interruption the user must see —
      // otherwise a silent feed is indistinguishable from completion. The
      // durable state is intact server-side, so a reload recovers it.
      source.close();
      if (!finished) {
        setConnectionLost(true);
      }
    };
    return () => {
      source.close();
    };
  }, [active, streamUrl]);

  return { lines, connectionLost };
}
