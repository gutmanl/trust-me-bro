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
      if (run) {
        // Replay everything recorded so far. For capture this in-memory event
        // log is the ONLY record of per-item outcomes — there is no durable
        // bracket state to re-derive, unlike extraction/reference-scan. A
        // capture batch often finishes before the client's EventSource
        // connects (fast/cached downloads, or items that fail validation
        // instantly), so gating the replay on isActive() dropped the entire
        // outcome silently: no error, no summary, nothing imported-looking.
        for (const event of run.eventsSoFar()) {
          controller.enqueue(sse("progress", event));
        }
        if (run.isActive()) {
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
        // Already finished: the replay above already carried its terminal
        // run_completed/run_cancelled, which drives the client's onDone.
        close();
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
