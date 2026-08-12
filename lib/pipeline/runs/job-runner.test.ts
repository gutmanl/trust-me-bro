import { describe, expect, it } from "vitest";

import { RunActiveError } from "../errors";
import { createJobRunner } from "./job-runner";
import type { RunProgressEvent } from "./types";

function eventTypes(events: RunProgressEvent<unknown>[]): string[] {
  return events.map((event) => event.type);
}

describe("createJobRunner: a throwing subscriber cannot wedge the run", () => {
  it("still finishes and clears the run when a subscriber throws on every event", async () => {
    // The realistic trigger: an SSE controller whose client vanished throws
    // from controller.enqueue(). Before the emit() guard this exception
    // escaped the loop, skipped active.delete, and left the run active
    // forever — blocking every future run for the project.
    const runner = createJobRunner();
    const handle = runner.submit(
      "proj_a",
      ["eins", "zwei"],
      (item) => item,
      async (item) => item,
    );
    handle.subscribe(() => {
      throw new Error("dead SSE controller");
    });

    const result = await handle.done;
    expect(result).toEqual({ succeeded: 2, failed: 0 });
    expect(handle.isActive()).toBe(false);
    // The project is free again: a new run submits without RunActiveError.
    expect(() =>
      runner.submit(
        "proj_a",
        ["drei"],
        (item) => item,
        async (item) => item,
      ),
    ).not.toThrow();
  });
});

describe("createJobRunner", () => {
  it("runs items sequentially and emits the full event sequence", async () => {
    const runner = createJobRunner({ generateRunId: () => "run-1" });
    const order: string[] = [];
    const handle = runner.submit(
      "proj_a",
      ["eins", "zwei"],
      (item) => item,
      async (item) => {
        order.push(item);
        return item.toUpperCase();
      },
    );
    const seen: RunProgressEvent<string>[] = [];
    handle.subscribe((event) => seen.push(event));

    const result = await handle.done;
    expect(result).toEqual({ succeeded: 2, failed: 0 });
    expect(order).toEqual(["eins", "zwei"]);
    expect(eventTypes(handle.eventsSoFar())).toEqual([
      "run_started",
      "item_started",
      "item_completed",
      "item_started",
      "item_completed",
      "run_completed",
    ]);
    expect(handle.isActive()).toBe(false);
  });

  it("counts step failures as item errors without aborting the run", async () => {
    const runner = createJobRunner();
    const handle = runner.submit(
      "proj_a",
      ["ok", "kaputt"],
      (item) => item,
      async (item) => {
        if (item === "kaputt") {
          throw new Error("Schritt fehlgeschlagen");
        }
        return item;
      },
    );
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 1, failed: 1 });
    const completed = handle
      .eventsSoFar()
      .filter((event) => event.type === "item_completed");
    expect(completed.at(-1)).toMatchObject({
      outcome: { status: "error", error: "Schritt fehlgeschlagen" },
    });
  });

  it("rejects a second run for the same project while one is active", async () => {
    const runner = createJobRunner();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runner.submit(
      "proj_a",
      ["x"],
      (item) => item,
      async () => blocker,
    );
    expect(runner.isRunning("proj_a")).toBe(true);
    expect(() =>
      runner.submit(
        "proj_a",
        ["y"],
        (item) => item,
        async () => undefined,
      ),
    ).toThrow(RunActiveError);

    // Other projects are unaffected (cross-project concurrency).
    const other = runner.submit(
      "proj_b",
      ["y"],
      (item) => item,
      async () => "fertig",
    );
    await other.done;

    release();
    await first.done;
    expect(runner.isRunning("proj_a")).toBe(false);
    // A finished run stays reachable for late viewers.
    expect(runner.currentRun("proj_a")?.runId).toBe(first.runId);
  });

  it("pauses between items, the in-flight item still completes (TMB-50)", async () => {
    const runner = createJobRunner();
    let releaseFirst!: () => void;
    const firstItem = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const handle = runner.submit(
      "proj_a",
      ["eins", "zwei"],
      (item) => item,
      async (item) => {
        started.push(item);
        if (item === "eins") {
          await firstItem;
        }
        return item;
      },
    );

    expect(handle.requestPause()).toBe(true);
    expect(handle.controlState()).toBe("pausing");
    // Pausing again is a no-op.
    expect(handle.requestPause()).toBe(false);

    releaseFirst();
    // Give the loop a tick to reach the gate.
    await new Promise((resolve) => setImmediate(resolve));
    expect(handle.controlState()).toBe("paused");
    expect(started).toEqual(["eins"]); // item 2 never started

    expect(handle.resume()).toBe(true);
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 2, failed: 0 });
    expect(eventTypes(handle.eventsSoFar())).toEqual([
      "run_started",
      "item_started",
      "run_pause_requested",
      "item_completed",
      "run_paused",
      "run_resumed",
      "item_started",
      "item_completed",
      "run_completed",
    ]);
  });

  it("cancels before the next item and ends with run_cancelled (TMB-50)", async () => {
    const runner = createJobRunner();
    let releaseFirst!: () => void;
    const firstItem = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const handle = runner.submit(
      "proj_a",
      ["eins", "zwei", "drei"],
      (item) => item,
      async (item) => {
        started.push(item);
        if (item === "eins") {
          await firstItem;
        }
        return item;
      },
    );

    expect(handle.requestCancel()).toBe(true);
    expect(handle.controlState()).toBe("cancelling");
    expect(handle.requestCancel()).toBe(false);

    releaseFirst();
    const result = await handle.done;
    // The in-flight item finished and counted; the rest never started.
    expect(result).toEqual({ succeeded: 1, failed: 0 });
    expect(started).toEqual(["eins"]);
    expect(handle.controlState()).toBe("cancelled");
    expect(handle.isActive()).toBe(false);
    expect(eventTypes(handle.eventsSoFar())).toEqual([
      "run_started",
      "item_started",
      "run_cancel_requested",
      "item_completed",
      "run_cancelled",
    ]);
    // The project slot is free again.
    expect(runner.isRunning("proj_a")).toBe(false);
  });

  it("cancel releases a pending pause instead of deadlocking (TMB-50)", async () => {
    const runner = createJobRunner();
    let releaseFirst!: () => void;
    const firstItem = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handle = runner.submit(
      "proj_a",
      ["eins", "zwei"],
      (item) => item,
      async (item) => {
        if (item === "eins") {
          await firstItem;
        }
        return item;
      },
    );

    handle.requestPause();
    releaseFirst();
    await new Promise((resolve) => setImmediate(resolve));
    expect(handle.controlState()).toBe("paused");

    handle.requestCancel();
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 1, failed: 0 });
    expect(handle.controlState()).toBe("cancelled");
  });

  it("refuses control requests after the run finished", async () => {
    const runner = createJobRunner();
    const handle = runner.submit(
      "proj_a",
      ["x"],
      (item) => item,
      async () => "ok",
    );
    await handle.done;
    expect(handle.requestPause()).toBe(false);
    expect(handle.resume()).toBe(false);
    expect(handle.requestCancel()).toBe(false);
  });

  it("replays buffered events to late subscribers via eventsSoFar", async () => {
    const runner = createJobRunner();
    const handle = runner.submit(
      "proj_a",
      ["x"],
      (item) => item,
      async () => "ok",
    );
    await handle.done;
    expect(eventTypes(handle.eventsSoFar())).toEqual([
      "run_started",
      "item_started",
      "item_completed",
      "run_completed",
    ]);
  });
});

describe("createJobRunner: subscribeRunStarts", () => {
  it("notifies once per submitted run, with the handle, and stops on unsubscribe", async () => {
    const runner = createJobRunner();
    const started: string[] = [];
    const unsubscribe = runner.subscribeRunStarts((handle) => {
      started.push(`${handle.projectId}:${handle.kind ?? "-"}`);
      // The handle is fully usable at notification time — the run has
      // already emitted run_started synchronously inside submit().
      expect(eventTypes(handle.eventsSoFar())).toContain("run_started");
    });

    const first = runner.submit(
      "proj_a",
      ["x"],
      (item) => item,
      async () => "ok",
      { kind: "extraction" },
    );
    await first.done;
    const second = runner.submit(
      "proj_a",
      ["y"],
      (item) => item,
      async () => "ok",
      { kind: "existence_check" },
    );
    await second.done;

    expect(started).toEqual(["proj_a:extraction", "proj_a:existence_check"]);

    unsubscribe();
    const third = runner.submit(
      "proj_a",
      ["z"],
      (item) => item,
      async () => "ok",
    );
    await third.done;
    expect(started).toEqual(["proj_a:extraction", "proj_a:existence_check"]);
  });

  it("survives a listener that throws (a vanished SSE client must not break submit)", async () => {
    const runner = createJobRunner();
    const seen: string[] = [];
    runner.subscribeRunStarts(() => {
      throw new Error("dead SSE controller");
    });
    runner.subscribeRunStarts((handle) => {
      seen.push(handle.runId);
    });

    const handle = runner.submit(
      "proj_a",
      ["x"],
      (item) => item,
      async () => "ok",
    );
    expect(seen).toEqual([handle.runId]);
    await expect(handle.done).resolves.toEqual({ succeeded: 1, failed: 0 });
  });
});
