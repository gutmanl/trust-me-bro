import {
  getActiveRunHandle,
  readProject,
  UnknownProjectError,
} from "@/lib/pipeline";

export const dynamic = "force-dynamic";

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

/**
 * Kind-agnostic SSE progress stream of whatever run is active for the project
 * (runner UI). The shared status bar subscribes here so it can show and
 * control the current run from any page, instead of each panel streaming only
 * its own kind. No live run → a trivial state event and close, exactly like
 * the per-kind streams.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/projects/[id]/run/stream">,
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

  const run = getActiveRunHandle(id);
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      // enqueue throws if the client already went away; swallowing it and
      // closing keeps that from escaping into the runner's emit() loop.
      const push = (event: string, data: unknown): void => {
        try {
          controller.enqueue(sse(event, data));
        } catch {
          close();
        }
      };

      if (run) {
        for (const event of run.eventsSoFar()) {
          push("progress", event);
        }
        unsubscribe = run.subscribe((event) => {
          push("progress", event);
          if (
            event.type === "run_completed" ||
            event.type === "run_cancelled"
          ) {
            close();
          }
        });
        return;
      }
      push("state", {});
      close();
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
