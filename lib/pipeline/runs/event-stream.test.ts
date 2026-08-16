import { describe, expect, it } from "vitest";

import { createActivityLedger } from "./activity-ledger";
import { createAutoChain } from "./auto-chain";
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
    expect([
      ...new Set(
        envelopes.map((e) => (e.source === "run" ? e.runId : e.triggerId)),
      ),
    ]).toEqual(["run-1", "run-2"]);
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

describe("streamProjectRunEvents: off-runner triggers (run visibility)", () => {
  function wedgedChain() {
    const ledger = createActivityLedger();
    const runner = createJobRunner({ ledger });
    const chain = createAutoChain({
      runner,
      ledger,
      startExistenceCheck: (async () => ({
        runId: "run-ec",
        projectId: "proj_a",
        kind: "existence_check",
        startedAt: new Date().toISOString(),
        isActive: () => false,
        eventsSoFar: () => [],
        subscribe: () => () => {},
        controlState: () => "running" as const,
        requestPause: () => false,
        resume: () => false,
        requestCancel: () => false,
        done: Promise.resolve({ succeeded: 1, failed: 0 }),
      })) as never,
      listRepairEvaluationSources: async () => ["src_a"],
      evaluateSourceRepair: () => new Promise<void>(() => {}),
    });
    return { runner, chain };
  }

  it("ships trigger events, replays to a mid-flight subscriber, and closes on cancel", async () => {
    const { runner, chain } = wedgedChain();
    const live: ProjectRunEnvelope[] = [];
    const stopLive = streamProjectRunEvents("proj_a", (e) => live.push(e), {
      runner,
      chain,
    });

    chain.enqueueExistenceCheck("proj_a");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(types(live)).toContain("trigger_started");

    // A client that connects MID-trigger sees it via the replay — the
    // capture-run-visibility precedent, applied to the chain's half.
    const late: ProjectRunEnvelope[] = [];
    const stopLate = streamProjectRunEvents("proj_a", (e) => late.push(e), {
      runner,
      chain,
    });
    expect(types(late)).toContain("trigger_started");
    const started = late.find((e) => e.event.type === "trigger_started");
    expect(started?.source).toBe("trigger");

    chain.activeTrigger("proj_a")?.requestCancel();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(types(live)).toContain("trigger_cancel_requested");
    expect(types(live)).toContain("trigger_cancelled");

    stopLive();
    stopLate();
  });
});
