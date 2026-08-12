import { describe, expect, it } from "vitest";

import { createJobRunner } from "./job-runner";
import {
  streamProjectRunEvents,
  subscribeProjectRunStarts,
} from "./event-stream";
import type { ProjectRunEnvelope } from "./event-stream";

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** A run whose single item blocks until released — lets a test observe the
 * stream while the run is genuinely mid-flight. */
function submitBlocking(
  runner: ReturnType<typeof createJobRunner>,
  projectId: string,
  kind: string,
): { release: () => void; done: Promise<unknown> } {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = runner.submit(
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

function types(envelopes: ProjectRunEnvelope[]): string[] {
  return envelopes.map((envelope) => envelope.event.type);
}

describe("subscribeProjectRunStarts", () => {
  it("only reports runs of its own project and unsubscribes cleanly", async () => {
    const runner = createJobRunner();
    const seen: string[] = [];
    const unsubscribe = subscribeProjectRunStarts(
      "proj_a",
      (handle) => seen.push(handle.projectId),
      { runner },
    );

    await runner.submit(
      "proj_b",
      ["x"],
      (item) => item,
      async () => "ok",
    ).done;
    await runner.submit(
      "proj_a",
      ["x"],
      (item) => item,
      async () => "ok",
    ).done;
    expect(seen).toEqual(["proj_a"]);

    unsubscribe();
    await runner.submit(
      "proj_a",
      ["y"],
      (item) => item,
      async () => "ok",
    ).done;
    expect(seen).toEqual(["proj_a"]);
  });
});

describe("streamProjectRunEvents", () => {
  it("replays the run that is already active and then follows it live", async () => {
    const runner = createJobRunner({ generateRunId: () => "run-1" });
    const run = submitBlocking(runner, "proj_a", "extraction");
    await tick(); // run_started + item_started are in the log

    const envelopes: ProjectRunEnvelope[] = [];
    const stop = streamProjectRunEvents(
      "proj_a",
      (envelope) => envelopes.push(envelope),
      { runner },
    );
    expect(types(envelopes)).toEqual(["run_started", "item_started"]);
    expect(envelopes[0]).toMatchObject({ kind: "extraction", runId: "run-1" });

    run.release();
    await run.done;
    expect(types(envelopes)).toEqual([
      "run_started",
      "item_started",
      "item_completed",
      "run_completed",
    ]);
    stop();
  });

  it("attaches to a run started later without losing its opening events", async () => {
    // The race this pins: submit() emits run_started (and the first
    // item_started) BEFORE it announces the run, so an attach that only
    // subscribed would never see them. Attaching replays eventsSoFar()
    // first, in the same synchronous turn as subscribe().
    const runner = createJobRunner({ generateRunId: () => "run-late" });
    const envelopes: ProjectRunEnvelope[] = [];
    const stop = streamProjectRunEvents(
      "proj_a",
      (envelope) => envelopes.push(envelope),
      { runner },
    );
    expect(envelopes).toEqual([]);

    const run = submitBlocking(runner, "proj_a", "research");
    expect(types(envelopes)).toEqual(["run_started", "item_started"]);
    expect(envelopes[0].kind).toBe("research");

    run.release();
    await run.done;
    expect(types(envelopes)).toEqual([
      "run_started",
      "item_started",
      "item_completed",
      "run_completed",
    ]);
    stop();
  });

  it("stays open across successive runs (the auto-chain case)", async () => {
    let counter = 0;
    const runner = createJobRunner({ generateRunId: () => `run-${++counter}` });
    const envelopes: ProjectRunEnvelope[] = [];
    const stop = streamProjectRunEvents(
      "proj_a",
      (envelope) => envelopes.push(envelope),
      { runner },
    );

    const first = submitBlocking(runner, "proj_a", "extraction");
    first.release();
    await first.done;
    const second = submitBlocking(runner, "proj_a", "existence_check");
    second.release();
    await second.done;

    // Nothing closed after the first run's terminal event: the second run's
    // envelopes arrive on the same stream.
    expect(
      envelopes.filter((e) => e.event.type === "run_completed"),
    ).toHaveLength(2);
    expect([...new Set(envelopes.map((e) => e.runId))]).toEqual([
      "run-1",
      "run-2",
    ]);
    expect([...new Set(envelopes.map((e) => e.kind))]).toEqual([
      "extraction",
      "existence_check",
    ]);
    stop();
  });

  it("ignores other projects' runs", async () => {
    const runner = createJobRunner();
    const envelopes: ProjectRunEnvelope[] = [];
    const stop = streamProjectRunEvents(
      "proj_a",
      (envelope) => envelopes.push(envelope),
      { runner },
    );
    const other = submitBlocking(runner, "proj_b", "extraction");
    other.release();
    await other.done;
    expect(envelopes).toEqual([]);
    stop();
  });

  it("delivers every event exactly once when a run is attached twice over", async () => {
    // Defensive dedupe: attaching the same runId again (belt and braces
    // against an attach path that fires for a run already followed) must not
    // replay its log a second time.
    const runner = createJobRunner({ generateRunId: () => "run-1" });
    const envelopes: ProjectRunEnvelope[] = [];
    const stop = streamProjectRunEvents(
      "proj_a",
      (envelope) => envelopes.push(envelope),
      { runner },
    );
    const run = submitBlocking(runner, "proj_a", "verification");
    // A second stream over the same runner must not disturb the first.
    const stopTwin = streamProjectRunEvents("proj_a", () => {}, { runner });
    run.release();
    await run.done;

    expect(types(envelopes)).toEqual([
      "run_started",
      "item_started",
      "item_completed",
      "run_completed",
    ]);
    stop();
    stopTwin();
  });

  it("stops delivering after the returned unsubscribe", async () => {
    const runner = createJobRunner();
    const envelopes: ProjectRunEnvelope[] = [];
    const stop = streamProjectRunEvents(
      "proj_a",
      (envelope) => envelopes.push(envelope),
      { runner },
    );
    const first = submitBlocking(runner, "proj_a", "extraction");
    stop();
    first.release();
    await first.done;
    const before = envelopes.length;

    const second = submitBlocking(runner, "proj_a", "research");
    second.release();
    await second.done;
    // Neither the running run's later events nor a whole new run reach a
    // torn-down stream.
    expect(envelopes).toHaveLength(before);
  });

  it("survives a consumer that throws (a vanished SSE client)", async () => {
    const runner = createJobRunner();
    const stop = streamProjectRunEvents(
      "proj_a",
      () => {
        throw new Error("dead SSE controller");
      },
      { runner },
    );
    const run = submitBlocking(runner, "proj_a", "extraction");
    run.release();
    await expect(run.done).resolves.toEqual({ succeeded: 1, failed: 0 });
    stop();
  });
});
