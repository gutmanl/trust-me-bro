import {
  getReferenceCaptureRun,
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
 * SSE progress stream of the reference-capture run (reference auto-import).
 * Unlike extraction/reference-scan there is no durable "state" to derive —
 * capture is a batch of self-durable per-item captures, not a bracketed run
 * (see run-reference-capture.ts) — so without a live run this simply closes
 * with a trivial state event instead of a register-derived snapshot.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/projects/[id]/reference-capture/stream">,
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

  const run = getReferenceCaptureRun(id);
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
      controller.enqueue(sse("state", {}));
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
