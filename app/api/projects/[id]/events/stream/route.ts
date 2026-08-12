import {
  getActiveRun,
  readProject,
  streamProjectRunEvents,
  UnknownProjectError,
} from "@/lib/pipeline";

export const dynamic = "force-dynamic";

/** Nothing has been sent for this long → send an SSE comment, so proxies and
 * the browser keep the idle connection alive. The stream is long-lived by
 * design now (it outlives individual runs), which is exactly the situation
 * that needs a heartbeat. */
const HEARTBEAT_MS = 25_000;

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

/**
 * THE project event stream (workbench epic): one SSE connection per open
 * project page carries the progress of every run of that project, whatever
 * its kind. It replaces the seven per-feature streams, which each closed on
 * `run_completed` — with the auto-chain starting a follow-up run right after
 * a run ends, a client watching one of those went silent exactly when the
 * next run began. This one stays open until the client disconnects and
 * attaches to each new run as it starts.
 *
 * Protocol:
 * - `state` — once on connect: `{ activeRun: ActiveRunStatus | null }`, the
 *   same snapshot the pages render server-side, so a reconnecting client
 *   re-syncs without a reload.
 * - `progress` — `{ kind, runId, event }` per run progress event. The client
 *   routes by `kind` (which panel) and `runId` (which run).
 * - `: ping` comments as a heartbeat.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/projects/[id]/events/stream">,
) {
  const { id } = await context.params;
  try {
    await readProject(id);
  } catch (error) {
    if (error instanceof UnknownProjectError) {
      return new Response("unknown project", { status: 404 });
    }
    throw error;
  }

  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Set by teardown, whether it was the client hanging up (cancel) or a
   * failed enqueue. Read back after the subscription is created, because the
   * initial replay can tear the connection down BEFORE there is anything to
   * unsubscribe. */
  let closed = false;

  const teardown = (): void => {
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        teardown();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      // enqueue throws once the client is gone; swallowing it and tearing
      // the subscriptions down keeps that from escaping into the runner's
      // emit() loop (which guards it too, but a dead stream must also stop
      // holding listeners).
      const push = (chunk: Uint8Array): void => {
        try {
          controller.enqueue(chunk);
        } catch {
          close();
        }
      };

      push(sse("state", { activeRun: getActiveRun(id) ?? null }));
      // Attaches to the currently active run AND to every run started later;
      // deliberately never closes on a terminal event.
      const stop = streamProjectRunEvents(id, (envelope) => {
        push(sse("progress", envelope));
      });
      if (closed) {
        // The client was already gone when the snapshot or the active run's
        // synchronous replay was pushed. teardown() ran before this
        // subscription existed, so drop it here — and install no heartbeat
        // on a controller that will never accept a chunk again.
        stop();
        return;
      }
      unsubscribe = stop;
      heartbeat = setInterval(() => {
        push(new TextEncoder().encode(": ping\n\n"));
      }, HEARTBEAT_MS);
    },
    cancel: teardown,
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // Long-lived stream: tell any reverse proxy not to buffer it.
      "x-accel-buffering": "no",
    },
  });
}
