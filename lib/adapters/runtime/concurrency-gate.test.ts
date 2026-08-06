import { afterEach, describe, expect, it } from "vitest";

import {
  __resetGlobalConcurrencyGateForTests,
  createConcurrencyGate,
  getGlobalConcurrencyGate,
} from "./concurrency-gate";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  __resetGlobalConcurrencyGateForTests();
});

describe("createConcurrencyGate", () => {
  it("never lets more than the capacity run concurrently", async () => {
    const gate = createConcurrencyGate(2);
    let active = 0;
    let peak = 0;
    const blockers = [deferred(), deferred(), deferred(), deferred()];
    const tasks = blockers.map((blocker) =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await blocker.promise;
        active -= 1;
      }),
    );
    // Give the first two tasks a chance to start; the rest must wait.
    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toBe(2);
    blockers.forEach((blocker) => blocker.resolve());
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });

  it("frees the slot when a task throws", async () => {
    const gate = createConcurrencyGate(1);
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(gate.run(async () => "after")).resolves.toBe("after");
  });

  it("passes results and preserves waiting order", async () => {
    const gate = createConcurrencyGate(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        gate.run(async () => {
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("getGlobalConcurrencyGate", () => {
  it("returns the same gate instance for every caller (global CLI cap)", () => {
    expect(getGlobalConcurrencyGate()).toBe(getGlobalConcurrencyGate());
  });
});
