import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../app/api/projects/[id]/events/stream/route";
import { getGlobalJobRunner } from "../lib/pipeline/runs/job-runner";
import { RegisterStore } from "../lib/register";
import type { ProjectConfig } from "../lib/register";

/**
 * The unified project event stream, at the route level (workbench epic). The
 * seven per-feature streams it replaced each closed on `run_completed`, so a
 * client kept watching a dead socket exactly when the auto-chain started the
 * next run. These tests pin the properties that fix depends on and that the
 * pipeline-level tests (lib/pipeline/runs/event-stream.test.ts) cannot see:
 * the SSE framing, the opening `state` envelope, that the response does NOT
 * end on a terminal event, and the heartbeat/cleanup of the long-lived
 * connection.
 *
 * app/** is outside the coverage gate; this test is here for correctness,
 * not for the ratio.
 */

const config: ProjectConfig = {
  rubric_version: "se-evidence-rubric-v1",
  adjudication_sample_rate: 0.1,
  backends: {
    primary: { cli: "claude", model_family: "anthropic" },
    secondary: { cli: "codex", model_family: "openai" },
  },
};

let workspace: string;

async function createProject(id: string): Promise<void> {
  await RegisterStore.forProject(id).create({
    id,
    research_question: "Wirkt X?",
    config,
    actor: "human:lg",
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-eventstream-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** A run whose single item blocks until released, so a test can observe the
 * stream while the run is genuinely mid-flight. Goes through the PROCESS
 * runner, because that is the one the route reads. */
function submitBlocking(
  projectId: string,
  kind: string,
): { release: () => void; done: Promise<unknown> } {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = getGlobalJobRunner().submit(
    projectId,
    ["item"],
    (item) => item,
    async () => {
      await blocked;
      return "ok";
    },
    { kind },
  );
  return { release, done: handle.done };
}

interface Frame {
  event: string | null;
  data: unknown;
  raw: string;
}

/** Reads the response body one SSE frame at a time. A frame the route never
 * sends makes `next()` reject — including the "stream closed" case, which is
 * exactly what the per-feature streams did on a terminal event. */
function frames(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<Frame> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const eventLine = raw
            .split("\n")
            .find((line) => line.startsWith("event: "));
          const dataLine = raw
            .split("\n")
            .find((line) => line.startsWith("data: "));
          return {
            event: eventLine ? eventLine.slice("event: ".length) : null,
            data: dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null,
            raw,
          };
        }
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("the event stream closed — it must stay open");
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel: (): Promise<void> => reader.cancel(),
  };
}

function open(projectId: string): Promise<Response> {
  return GET(
    new Request(`http://127.0.0.1/api/projects/${projectId}/events/stream`),
    { params: Promise.resolve({ id: projectId }) },
  ) as Promise<Response>;
}

describe("GET /api/projects/[id]/events/stream", () => {
  it("answers 404 for an unknown project", async () => {
    const response = await open("proj_gibt-es-nicht");
    expect(response.status).toBe(404);
  });

  it("opens with the active-run snapshot and the SSE headers", async () => {
    const projectId = "proj_events-snapshot";
    await createProject(projectId);
    const run = submitBlocking(projectId, "extraction");

    const response = await open(projectId);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    // Long-lived body: a buffering reverse proxy would swallow the feed.
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const stream = frames(response);
    const state = await stream.next();
    expect(state.event).toBe("state");
    expect(state.data).toMatchObject({
      activity: { source: "run", kind: "extraction", phase: "running" },
    });

    // The run's log so far is replayed as progress envelopes, tagged.
    const started = await stream.next();
    expect(started.event).toBe("progress");
    expect(started.data).toMatchObject({
      kind: "extraction",
      event: { type: "run_started" },
    });

    run.release();
    await run.done;
    await stream.cancel();
  });

  it("reports no active run on a quiet project", async () => {
    const projectId = "proj_events-quiet";
    await createProject(projectId);
    const stream = frames(await open(projectId));
    expect(await stream.next()).toMatchObject({
      event: "state",
      data: { activity: null },
    });
    await stream.cancel();
  });

  it("stays open across successive runs instead of closing on run_completed", async () => {
    const projectId = "proj_events-chain";
    await createProject(projectId);
    const stream = frames(await open(projectId));
    expect((await stream.next()).event).toBe("state");

    // A run that starts AFTER the client connected must be picked up whole:
    // the runner emits run_started before it announces the run, so the
    // attach replays the log before subscribing.
    const first = submitBlocking(projectId, "research");
    expect((await stream.next()).data).toMatchObject({
      kind: "research",
      event: { type: "run_started" },
    });
    first.release();
    await first.done;

    const seen: string[] = [];
    // item_started, item_completed, run_completed — the terminal event does
    // NOT end the response; frames.next() would throw if it had.
    while (!seen.includes("run_completed")) {
      const frame = await stream.next();
      seen.push((frame.data as { event: { type: string } }).event.type);
    }
    expect(seen).toEqual(["item_started", "item_completed", "run_completed"]);

    // The auto-chain case: the very next run of the project arrives on the
    // same connection, with its own runId and kind.
    const second = submitBlocking(projectId, "existence_check");
    expect((await stream.next()).data).toMatchObject({
      kind: "existence_check",
      event: { type: "run_started" },
    });
    second.release();
    await second.done;
    await stream.cancel();
  });

  it("ignores runs of other projects", async () => {
    const projectId = "proj_events-mine";
    await createProject(projectId);
    await createProject("proj_events-theirs");
    const stream = frames(await open(projectId));
    expect((await stream.next()).event).toBe("state");

    const other = submitBlocking("proj_events-theirs", "extraction");
    other.release();
    await other.done;
    // Nothing from the other project got in: the next frame is this
    // project's own run.
    const mine = submitBlocking(projectId, "verification");
    expect((await stream.next()).data).toMatchObject({ kind: "verification" });
    mine.release();
    await mine.done;
    await stream.cancel();
  });

  it("heartbeats an idle connection and clears the interval on disconnect", async () => {
    // Only the interval is faked: the runner and the register work on
    // promises and real IO, which fake timers must not stall.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const projectId = "proj_events-heartbeat";
    await createProject(projectId);
    const stream = frames(await open(projectId));
    expect((await stream.next()).event).toBe("state");

    vi.advanceTimersByTime(25_000);
    const ping = await stream.next();
    // An SSE comment: no event, no data — it only keeps the socket warm.
    expect(ping.raw).toBe(": ping");
    expect(ping.event).toBeNull();

    expect(vi.getTimerCount()).toBe(1);
    await stream.cancel();
    // cancel() tears the connection down: no leaked heartbeat. The run
    // subscriptions it also drops are pinned in event-stream.test.ts, where
    // the runner is injectable.
    expect(vi.getTimerCount()).toBe(0);
  });
});
