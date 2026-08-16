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

import type { ActiveRunStatus, ProjectActivity } from "@/lib/pipeline";

/** One progress event of one run or off-runner trigger, as the unified
 * stream ships it. Mirrors the server's ProjectRunEnvelope; the event
 * payload stays an opaque record here, exactly as the per-panel describe()
 * functions expect it. */
export type RunEnvelope =
  | {
      source: "run";
      kind: string | null;
      runId: string;
      event: Record<string, unknown>;
    }
  | {
      source: "trigger";
      kind: string;
      triggerId: string;
      event: Record<string, unknown>;
    };

/** The id that tells one run/trigger from its successor. */
function envelopeId(envelope: RunEnvelope): string {
  return envelope.source === "run" ? envelope.runId : envelope.triggerId;
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
  activity: ProjectActivity | null;
  activeRun: ActiveRunStatus | null;
  connectionLost: boolean;
  subscribe: (subscriber: Subscriber) => () => void;
}

const ProjectEventStreamContext = createContext<ProjectEventStreamValue>({
  activity: null,
  activeRun: null,
  connectionLost: false,
  subscribe: () => () => {},
});

function isTerminal(type: unknown): boolean {
  return (
    type === "run_completed" ||
    type === "run_cancelled" ||
    type === "trigger_completed" ||
    type === "trigger_cancelled"
  );
}

function sameActivity(a: ProjectActivity, b: ProjectActivity): boolean {
  if (a.source === "run" && b.source === "run") {
    return (
      a.runId === b.runId &&
      a.kind === b.kind &&
      a.phase === b.phase &&
      a.completed === b.completed &&
      a.total === b.total
    );
  }
  if (a.source === "trigger" && b.source === "trigger") {
    return a.triggerId === b.triggerId && a.phase === b.phase;
  }
  return false;
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
function reduceActivity(
  previous: ProjectActivity | null,
  envelope: RunEnvelope,
): ProjectActivity | null {
  const next = foldActivity(previous, envelope);
  if (previous !== null && next !== null && sameActivity(previous, next)) {
    return previous;
  }
  return next;
}

function foldActivity(
  previous: ProjectActivity | null,
  envelope: RunEnvelope,
): ProjectActivity | null {
  const { event } = envelope;
  const id = envelopeId(envelope);
  const previousId =
    previous === null
      ? null
      : previous.source === "run"
        ? previous.runId
        : previous.triggerId;
  if (isTerminal(event.type)) {
    // Only the activity the event names ends — a late terminal event of an
    // already-replaced run/trigger cannot null its successor.
    return previous !== null && previousId !== id ? previous : null;
  }
  if (envelope.source === "trigger") {
    if (event.type === "trigger_started") {
      return {
        source: "trigger",
        triggerId: envelope.triggerId,
        kind: envelope.kind as (ProjectActivity & {
          source: "trigger";
        })["kind"],
        description: String(event.description ?? ""),
        startedAt: String(event.startedAt ?? new Date().toISOString()),
        phase: "running",
      };
    }
    if (
      event.type === "trigger_cancel_requested" &&
      previous?.source === "trigger" &&
      previous.triggerId === envelope.triggerId
    ) {
      return { ...previous, phase: "cancelling" };
    }
    return previous;
  }
  const base: ProjectActivity & { source: "run" } =
    previous !== null && previous.source === "run" && previous.runId === id
      ? previous
      : {
          source: "run",
          runId: envelope.runId,
          kind: envelope.kind,
          phase: "running",
          completed: 0,
          total: 0,
          // Placeholder until run_started (below) or the next state
          // snapshot supplies the server's own value.
          startedAt: new Date().toISOString(),
        };
  switch (event.type) {
    case "run_started":
      return {
        ...base,
        total: Number(event.totalItems) || base.total,
        startedAt: String(event.startedAt ?? base.startedAt),
      };
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
 * `initialActivity` is the server-rendered snapshot, re-read on every server
 * render (the project layout is force-dynamic). It is adopted when the PROP
 * changes identity — i.e. when the server has something new to say — never
 * merely because it differs from what the stream established. An unrelated
 * router.refresh() therefore cannot clobber in-flight progress, and a
 * refresh whose render started before the current run did cannot roll the
 * client back to a run that has since ended.
 */
function activityId(activity: ProjectActivity | null): string | null {
  if (activity === null) {
    return null;
  }
  return activity.source === "run" ? activity.runId : activity.triggerId;
}

export function ProjectEventStreamProvider({
  projectId,
  initialActivity,
  children,
}: {
  projectId: string;
  initialActivity: ProjectActivity | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const [activity, setActivity] = useState<ProjectActivity | null>(
    initialActivity,
  );
  const [connectionLost, setConnectionLost] = useState(false);
  const [serverActivityId, setServerActivityId] = useState<string | null>(
    activityId(initialActivity),
  );

  // Render-phase state adjustment (established idiom in this codebase):
  // adopt the server snapshot exactly when the prop's identity changed.
  if (activityId(initialActivity) !== serverActivityId) {
    setServerActivityId(activityId(initialActivity));
    setActivity(initialActivity);
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
  const snapshot = useRef<{ activity: ProjectActivity | null } | undefined>(
    undefined,
  );

  const subscribe = useCallback((subscriber: Subscriber) => {
    subscribers.current.add(subscriber);
    if (snapshot.current !== undefined) {
      subscriber.onSync?.(runHalfOf(snapshot.current.activity));
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
        activity: ProjectActivity | null;
      };
      // A fresh connection replays the active run's events, so whatever was
      // buffered from the previous one would duplicate.
      buffer.current = [];
      snapshot.current = { activity: payload.activity };
      setConnectionLost(false);
      setActivity(payload.activity);
      for (const subscriber of subscribers.current) {
        subscriber.onSync?.(runHalfOf(payload.activity));
      }
    });

    source.addEventListener("progress", (event) => {
      const envelope = JSON.parse((event as MessageEvent).data) as RunEnvelope;
      if (
        buffer.current.length > 0 &&
        envelopeId(buffer.current[0]) !== envelopeId(envelope)
      ) {
        buffer.current = [];
      }
      buffer.current.push(envelope);
      setActivity((previous) => reduceActivity(previous, envelope));
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
  const activeRun = runHalfOf(activity);
  const value = useMemo(
    () => ({ activity, activeRun, connectionLost, subscribe }),
    [activity, activeRun, connectionLost, subscribe],
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
  activity: ProjectActivity | null;
} {
  const { activity, activeRun, connectionLost, subscribe } = useContext(
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

  return { activeRun, activity, connectionLost };
}

/** The run half of an activity — what panel-level consumers (their feeds,
 * their sync hooks) understand; a chain trigger has no items to feed. */
function runHalfOf(activity: ProjectActivity | null): ActiveRunStatus | null {
  return activity !== null && activity.source === "run" ? activity : null;
}
