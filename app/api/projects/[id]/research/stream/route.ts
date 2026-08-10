import {
  getResearchRun,
  getResearchState,
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
 * SSE progress stream of the initial research run (TMB-55), identical in
 * shape to the extraction stream: a live run replays its buffered events
 * and streams until completion; without one, a single register-derived
 * state snapshot is emitted and the stream closes, so the client needs no
 * second code path for "already finished".
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/projects/[id]/research/stream">,
) {
  const { id } = await context.params;
  let register;
  try {
    register = await readProject(id);
  } catch (error) {
    if (error instanceof UnknownProjectError) {
      return new Response("unknown project", { status: 404 });
    }
    throw error;
  }

  const run = getResearchRun(id);
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
      if (run && run.isActive()) {
        for (const event of run.eventsSoFar()) {
          controller.enqueue(sse("progress", event));
        }
        unsubscribe = run.subscribe((event) => {
          controller.enqueue(sse("progress", event));
          if (
            event.type === "run_completed" ||
            event.type === "run_cancelled"
          ) {
            close();
          }
        });
        return;
      }
      controller.enqueue(sse("state", getResearchState(id, register)));
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
