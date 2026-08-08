"use client";

import { useEffect, useRef } from "react";

// Sanctioned deep import: the pure reducer must not travel through the
// pipeline barrel (which transitively imports node:fs) into a client bundle.
import type { EffortState } from "@/lib/pipeline/adjudication/effort-timer";
import {
  effortReducer,
  effortSeconds,
  startEffort,
} from "@/lib/pipeline/adjudication/effort-timer";

/**
 * Casual per-claim effort measurement (TMB-36): wires the pure effort
 * reducer to DOM reality — pointer/key activity, tab visibility — and
 * restarts whenever the selected claim changes. No re-renders: the state
 * lives in a ref and is read once at submit time via `currentSeconds()`.
 */
export function useEffortTimer(claimId: string | null): {
  currentSeconds: () => number;
} {
  const state = useRef<EffortState | null>(null);

  useEffect(() => {
    if (claimId === null) {
      state.current = null;
      return;
    }
    state.current = startEffort(Date.now());

    const dispatch = (type: "activity" | "hidden" | "visible"): void => {
      if (state.current) {
        state.current = effortReducer(state.current, {
          type,
          at: Date.now(),
        });
      }
    };
    const onActivity = (): void => dispatch("activity");
    const onVisibility = (): void =>
      dispatch(document.hidden ? "hidden" : "visible");

    window.addEventListener("pointermove", onActivity);
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    window.addEventListener("scroll", onActivity, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("scroll", onActivity, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [claimId]);

  return {
    currentSeconds: () =>
      state.current ? effortSeconds(state.current, Date.now()) : 0,
  };
}
