import { describe, expect, it } from "vitest";

import { RunActiveError } from "../errors";
import { createJobRunner } from "./job-runner";
import type { RunProgressEvent } from "./types";

function eventTypes(events: RunProgressEvent<unknown>[]): string[] {
  return events.map((event) => event.type);
}

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
