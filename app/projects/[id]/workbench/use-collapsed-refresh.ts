"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

/**
 * `router.refresh()` collapsed to at most one call per burst.
 *
 * The workbench refreshes its server-rendered claim state on every finished
 * item of a run, so a decided claim appears without waiting for the whole
 * run. That is fine while events trickle in — but the shared stream REPLAYS
 * a run's events on every (re)connect, so a reconnect mid-run delivers
 * dozens of `item_completed` envelopes in one tick. Refreshing per envelope
 * turned that into a burst of identical server renders (the review
 * workspace's behaviour before it moved here). Collapsing them costs one
 * frame of latency and removes the burst entirely.
 */
export function useCollapsedRefresh(delayMs = 120): () => void {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  return useCallback(() => {
    if (timer.current !== null) {
      return; // a refresh is already scheduled for this burst
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      router.refresh();
    }, delayMs);
  }, [delayMs, router]);
}
