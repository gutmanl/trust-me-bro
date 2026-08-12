"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import type { ActiveRunStatus } from "@/lib/pipeline";

/** One progress event of one run, as the unified stream ships it. Mirrors
 * the server's ProjectRunEnvelope; the event payload stays an opaque record
 * here, exactly as the per-panel describe() functions expect it. */
export interface RunEnvelope {
  kind: string | null;
  runId: string;
  event: Record<string, unknown>;
}

interface Subscriber {
  /** Only envelopes of this run kind are delivered; undefined = all. */
  kind?: string;
  onEvent: (envelope: RunEnvelope) => void;
  /** "Drop whatever you accumulated, here is the truth": called with the
   * connection snapshot — once at subscribe time (if the connection already
   * delivered one) and again on every reconnect, always immediately before
   * the events of the active run are (re)played. */
  onSync?: (activeRun: ActiveRunStatus | null) => void;
}

interface ProjectEventStreamValue {
  activeRun: ActiveRunStatus | null;
  connectionLost: boolean;
  subscribe: (subscriber: Subscriber) => () => void;
}

const ProjectEventStreamContext = createContext<ProjectEventStreamValue>({
  activeRun: null,
  connectionLost: false,
  subscribe: () => () => {},
});

function isTerminal(type: unknown): boolean {
  return type === "run_completed" || type === "run_cancelled";
}

function sameStatus(a: ActiveRunStatus, b: ActiveRunStatus): boolean {
  return (
    a.runId === b.runId &&
    a.kind === b.kind &&
    a.phase === b.phase &&
    a.completed === b.completed &&
    a.total === b.total
  );
}

/**
 * The project's live run status, folded from the stream. Kept out of the
 * component so the reconciliation rules are readable in one place:
 *
 * - A terminal event ends the run — but only the run it names, so a late
 *   terminal event of an already-replaced run cannot null its successor.
 * - Any other event ADOPTS a run the client did not know yet. That is what
 *   makes an auto-chained follow-up run visible without a page refresh: the
 *   server-rendered snapshot may never mention it.
 * - `completed` comes from the event's absolute 0-based index, never from an
 *   increment: the stream replays a run's events on (re)connect, and
 *   incrementing would double-count what the snapshot already reflects.
 * - An event that changes nothing returns the PREVIOUS object, not an equal
 *   copy. Most envelopes (item_started, and every event during a reconnect's
 *   replay) say nothing new about the status, and every re-render of this
 *   provider re-renders every start-gated button on the page.
 */
function reduceActiveRun(
  previous: ActiveRunStatus | null,
  envelope: RunEnvelope,
): ActiveRunStatus | null {
  const next = foldActiveRun(previous, envelope);
  if (previous !== null && next !== null && sameStatus(previous, next)) {
    return previous;
  }
  return next;
}

function foldActiveRun(
  previous: ActiveRunStatus | null,
  envelope: RunEnvelope,
): ActiveRunStatus | null {
  const { event, runId, kind } = envelope;
  if (isTerminal(event.type)) {
    return previous !== null && previous.runId !== runId ? previous : null;
  }
  const base: ActiveRunStatus =
    previous !== null && previous.runId === runId
      ? previous
      : { runId, kind, phase: "running", completed: 0, total: 0 };
  switch (event.type) {
    case "run_started":
      return { ...base, total: Number(event.totalItems) || base.total };
    case "item_completed":
      return {
        ...base,
        completed: Math.max(base.completed, (Number(event.index) || 0) + 1),
      };
    case "run_pause_requested":
      return { ...base, phase: "pausing" };
    case "run_paused":
      return { ...base, phase: "paused" };
    case "run_resumed":
      return { ...base, phase: "running" };
    case "run_cancel_requested":
      return { ...base, phase: "cancelling" };
    default:
      return base;
  }
}

/**
 * ONE EventSource per open project, feeding every panel (workbench epic).
 * Before this, each feature opened its own stream against its own route, and
 * every one of those closed on `run_completed` — so with the auto-chain
 * starting the next run immediately, a client watching one of them went
 * silent exactly when the next run began. The unified stream stays open
 * across successive runs and distributes each envelope to the subscribers
 * that care about its kind.
 *
 * `initialRun` is the server-rendered snapshot, re-read on every server
 * render (the project layout is force-dynamic). It is adopted when the PROP
 * changes identity — i.e. when the server has something new to say — never
 * merely because it differs from what the stream established. An unrelated
 * router.refresh() therefore cannot clobber in-flight progress, and a
 * refresh whose render started before the current run did cannot roll the
 * client back to a run that has since ended.
 */
export function ProjectEventStreamProvider({
  projectId,
  initialRun,
  children,
}: {
  projectId: string;
  initialRun: ActiveRunStatus | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const [activeRun, setActiveRun] = useState<ActiveRunStatus | null>(
    initialRun,
  );
  const [connectionLost, setConnectionLost] = useState(false);
  const [serverRunId, setServerRunId] = useState<string | null>(
    initialRun?.runId ?? null,
  );

  // Render-phase state adjustment (established idiom in this codebase):
  // adopt the server snapshot exactly when the prop's run identity changed.
  if ((initialRun?.runId ?? null) !== serverRunId) {
    setServerRunId(initialRun?.runId ?? null);
    setActiveRun(initialRun);
  }

  const subscribers = useRef<Set<Subscriber>>(new Set());
  /** Envelopes of the most recent run seen on this connection, replayed to
   * subscribers that mount later (a client-side navigation to a panel whose
   * run is already mid-flight). The server does the same for a client that
   * connects mid-run, so both entry points show the same feed. */
  const buffer = useRef<RunEnvelope[]>([]);
  /** Latest connection snapshot, or undefined before the first one. Kept in
   * a ref (not only in state) so a subscriber that mounts later gets the
   * same "snapshot, then replay" sequence a connecting client gets. */
  const snapshot = useRef<{ activeRun: ActiveRunStatus | null } | undefined>(
    undefined,
  );

  const subscribe = useCallback((subscriber: Subscriber) => {
    subscribers.current.add(subscriber);
    if (snapshot.current !== undefined) {
      subscriber.onSync?.(snapshot.current.activeRun);
    }
    for (const envelope of buffer.current) {
      if (subscriber.kind === undefined || envelope.kind === subscriber.kind) {
        subscriber.onEvent(envelope);
      }
    }
    return () => {
      subscribers.current.delete(subscriber);
    };
  }, []);

  useEffect(() => {
    const source = new EventSource(`/api/projects/${projectId}/events/stream`);

    source.addEventListener("open", () => {
      setConnectionLost(false);
    });

    source.addEventListener("state", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        activeRun: ActiveRunStatus | null;
      };
      // A fresh connection replays the active run's events, so whatever was
      // buffered from the previous one would duplicate.
      buffer.current = [];
      snapshot.current = { activeRun: payload.activeRun };
      setConnectionLost(false);
      setActiveRun(payload.activeRun);
      for (const subscriber of subscribers.current) {
        subscriber.onSync?.(payload.activeRun);
      }
    });

    source.addEventListener("progress", (event) => {
      const envelope = JSON.parse((event as MessageEvent).data) as RunEnvelope;
      if (buffer.current[0]?.runId !== envelope.runId) {
        buffer.current = [];
      }
      buffer.current.push(envelope);
      setActiveRun((previous) => reduceActiveRun(previous, envelope));
      for (const subscriber of subscribers.current) {
        if (
          subscriber.kind === undefined ||
          subscriber.kind === envelope.kind
        ) {
          subscriber.onEvent(envelope);
        }
      }
      if (isTerminal(envelope.event.type)) {
        // Server-rendered state (claim statuses, derived panel state, the
        // layout's own snapshot) catches up on the run's terminal event.
        router.refresh();
      }
    });

    source.onerror = () => {
      // EventSource reconnects on its own; the notice stays up until it
      // does. A silent feed must never be indistinguishable from "the run
      // ended" — the durable state is intact server-side either way.
      setConnectionLost(true);
    };

    return () => {
      source.close();
      buffer.current = [];
      snapshot.current = undefined;
    };
  }, [projectId, router]);

  // Memoized so a re-render that changed nothing (a router.refresh() landing
  // with the same run, a parent re-render) does not churn every consumer —
  // `subscribe` is stable, so the value only changes when the status or the
  // connection state genuinely did.
  const value = useMemo(
    () => ({ activeRun, connectionLost, subscribe }),
    [activeRun, connectionLost, subscribe],
  );

  return (
    <ProjectEventStreamContext.Provider value={value}>
      {children}
    </ProjectEventStreamContext.Provider>
  );
}

/**
 * Subscribes to the project's run events, optionally narrowed to one run
 * kind. `onEvent` and `onSync` travel through a ref, so callers need not
 * memoize them and the subscription is not re-created on every render.
 * Returns the project's live run status and whether the connection is
 * currently down.
 *
 * `onSync` is the "here is the connection's truth, drop what you had" hook:
 * it fires once when this subscriber joins an already-connected stream and
 * again on every reconnect, in both cases immediately before the active
 * run's events are (re)played. Consumers that accumulate something volatile
 * from the events (a progress feed) rebuild it from there.
 */
export function useProjectEvents(
  filter?: { kind?: string },
  onEvent?: (envelope: RunEnvelope) => void,
  onSync?: (activeRun: ActiveRunStatus | null) => void,
): {
  connectionLost: boolean;
  activeRun: ActiveRunStatus | null;
} {
  const { activeRun, connectionLost, subscribe } = useContext(
    ProjectEventStreamContext,
  );
  const kind = filter?.kind;
  const handlers = useRef({ onEvent, onSync });
  useEffect(() => {
    handlers.current = { onEvent, onSync };
  });

  useEffect(
    () =>
      subscribe({
        kind,
        onEvent: (envelope) => handlers.current.onEvent?.(envelope),
        onSync: (snapshotRun) => handlers.current.onSync?.(snapshotRun),
      }),
    [kind, subscribe],
  );

  return { activeRun, connectionLost };
}
