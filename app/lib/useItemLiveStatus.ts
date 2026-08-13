"use client";

import { useState } from "react";

import { useProjectEvents } from "./ProjectEventStream";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The item ids of `kind`-runs that are live RIGHT NOW — between their
 * item_started and item_completed (source work items). This is what flips a
 * row from "wartet" to "läuft" without waiting for the next server render:
 * the server VM only knows the state as of its render, and the global
 * refresh fires on item COMPLETION, so the started-but-unfinished window is
 * visible only through the stream.
 *
 * Reconnect-safe by the stream's own contract: onSync clears the set, and
 * the replay of the active run's events rebuilds exactly the in-flight
 * items (an item_completed deletes what its item_started added).
 */
export function useItemLiveStatus(kind: string): ReadonlySet<string> {
  const [running, setRunning] = useState<ReadonlySet<string>>(EMPTY);
  useProjectEvents(
    { kind },
    (envelope) => {
      const type = envelope.event.type;
      if (type === "item_started") {
        const id = String(envelope.event.itemId);
        setRunning((previous) => {
          if (previous.has(id)) {
            return previous;
          }
          const next = new Set(previous);
          next.add(id);
          return next;
        });
      } else if (type === "item_completed") {
        const id = String(envelope.event.itemId);
        setRunning((previous) => {
          if (!previous.has(id)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(id);
          return next;
        });
      } else if (type === "run_completed" || type === "run_cancelled") {
        setRunning((previous) => (previous.size === 0 ? previous : EMPTY));
      }
    },
    () => {
      setRunning((previous) => (previous.size === 0 ? previous : EMPTY));
    },
  );
  return running;
}
