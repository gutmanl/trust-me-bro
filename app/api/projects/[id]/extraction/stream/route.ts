import {
  deriveExtractionActivity,
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
 * SSE progress stream of the extraction run (Grobentwurf: Prüf-Fortschritt
 * als Ereignisstrom). A live run replays its buffered events and streams
 * until completion; without one, a single state snapshot derived from the
 * register is emitted and the stream closes — the client needs no second
 * code path for "already finished".
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/projects/[id]/extraction/stream">,
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

  // The project-level handle, narrowed to this feature: the runner is
  // single-writer per project, so an active run of another kind is simply
  // not this stream's business.
  const active = getActiveRunHandle(id);
  const run = active?.kind === "extraction" ? active : undefined;
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
      // No live run left to follow, so the snapshot is by definition the
      // one of a finished pass.
      controller.enqueue(
        sse("state", deriveExtractionActivity(register, false)),
      );
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
