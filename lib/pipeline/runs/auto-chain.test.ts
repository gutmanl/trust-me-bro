import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceExtractionSummary } from "../extraction/run-source-extraction";
import type { ExistenceCheckItemResult } from "../verification/run-existence-check";
import { createAutoChain } from "./auto-chain";
import { createJobRunner } from "./job-runner";
import type { JobRunner } from "./job-runner";
import type { RunHandle } from "./types";

const fakeExtractionSummary: SourceExtractionSummary = {
  outcome: "completed",
  created: 0,
  merged: 0,
  message: "ok",
};

const fakeExistenceCheckResult: ExistenceCheckItemResult = {
  claimId: "claim_1",
  passed: true,
  message: "ok",
};

/** A start-fn fake that goes through the REAL job runner's submit(), so
 * calling it while another run is still active for the project throws
 * RunActiveError exactly like the real start-fns would — the sequencing
 * assertions below rely on that. */
function fakeExtraction(runner: JobRunner) {
  return vi.fn(
    async (
      projectId: string,
      sourceId: string,
      deps?: { runner?: JobRunner },
    ): Promise<RunHandle<SourceExtractionSummary>> => {
      const r = deps?.runner ?? runner;
      return r.submit(
        projectId,
        [sourceId],
        (id) => id,
        async () => fakeExtractionSummary,
        { kind: "extraction" },
      );
    },
  );
}

function fakeExistenceCheck(runner: JobRunner) {
  return vi.fn(
    async (
      projectId: string,
      deps?: { runner?: JobRunner },
    ): Promise<RunHandle<ExistenceCheckItemResult>> => {
      const r = deps?.runner ?? runner;
      return r.submit(
        projectId,
        ["existence_check_item"],
        (id) => id,
        async () => fakeExistenceCheckResult,
        { kind: "existence_check" },
      );
    },
  );
}

/** Throwing extraction fake, for the "one step's failure doesn't kill the
 * drain" tests: rejects for a magic sourceId, otherwise delegates to a real
 * submit like fakeExtraction above. */
function fakeExtractionThatFailsFor(
  runner: JobRunner,
  failingSourceId: string,
) {
  return vi.fn(
    async (
      projectId: string,
      sourceId: string,
      deps?: { runner?: JobRunner },
    ): Promise<RunHandle<SourceExtractionSummary>> => {
      if (sourceId === failingSourceId) {
        throw new Error(`boom on ${sourceId}`);
      }
      const r = deps?.runner ?? runner;
      return r.submit(
        projectId,
        [sourceId],
        (id) => id,
        async () => fakeExtractionSummary,
        { kind: "extraction" },
      );
    },
  );
}

describe("createAutoChain: sequential ordering", () => {
  it("waits for an already-active run before starting a queued extraction trigger", async () => {
    const runner = createJobRunner();
    const startSourceExtraction = fakeExtraction(runner);
    const startExistenceCheck = fakeExistenceCheck(runner);
    const chain = createAutoChain({
      runner,
      startSourceExtraction,
      startExistenceCheck,
    });

    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manual = runner.submit(
      "proj_a",
      ["x"],
      (item) => item,
      async () => blocker,
      { kind: "verification" },
    );

    chain.enqueueSourceExtraction("proj_a", "src_1");

    // The manual run is still active — the queued trigger must not have
    // fired yet, however many microtask ticks pass.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(startSourceExtraction).not.toHaveBeenCalled();

    release();
    await manual.done;

    await vi.waitFor(() => {
      expect(startSourceExtraction).toHaveBeenCalledTimes(1);
    });
    expect(startSourceExtraction).toHaveBeenCalledWith("proj_a", "src_1", {
      runner,
    });
  });
});

describe("createAutoChain: extraction → existence-check chaining", () => {
  it("runs an existence check right after a successful extraction trigger", async () => {
    const runner = createJobRunner();
    const startSourceExtraction = fakeExtraction(runner);
    const startExistenceCheck = fakeExistenceCheck(runner);
    const chain = createAutoChain({
      runner,
      startSourceExtraction,
      startExistenceCheck,
    });

    chain.enqueueSourceExtraction("proj_a", "src_1");

    await vi.waitFor(() => {
      expect(startExistenceCheck).toHaveBeenCalledTimes(1);
    });
    expect(startSourceExtraction).toHaveBeenCalledTimes(1);
    // Extraction happened before the existence check it triggers.
    const extractionOrder = startSourceExtraction.mock.invocationCallOrder[0];
    const checkOrder = startExistenceCheck.mock.invocationCallOrder[0];
    expect(extractionOrder).toBeLessThan(checkOrder);

    await vi.waitFor(() => {
      expect(chain.pendingTriggerCount("proj_a")).toBe(0);
    });
  });

  it("an explicit existence-check enqueue (revision) runs standalone", async () => {
    const runner = createJobRunner();
    const startSourceExtraction = fakeExtraction(runner);
    const startExistenceCheck = fakeExistenceCheck(runner);
    const chain = createAutoChain({
      runner,
      startSourceExtraction,
      startExistenceCheck,
    });

    chain.enqueueExistenceCheck("proj_a");

    await vi.waitFor(() => {
      expect(startExistenceCheck).toHaveBeenCalledTimes(1);
    });
    expect(startSourceExtraction).not.toHaveBeenCalled();
  });
});

describe("createAutoChain: coalescing", () => {
  it("collapses consecutive identical extraction triggers into one pass", async () => {
    const runner = createJobRunner();
    const startSourceExtraction = fakeExtraction(runner);
    const startExistenceCheck = fakeExistenceCheck(runner);
    const chain = createAutoChain({
      runner,
      startSourceExtraction,
      startExistenceCheck,
    });

    // Block the queue behind an active manual run so all three enqueues
    // land in the pending array together, before the drain loop dequeues
    // anything — otherwise the first enqueue would already have been
    // dequeued before the second and third arrive.
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manual = runner.submit(
      "proj_a",
      ["x"],
      (item) => item,
      async () => blocker,
      { kind: "verification" },
    );

    chain.enqueueSourceExtraction("proj_a", "src_1");
    chain.enqueueSourceExtraction("proj_a", "src_1"); // duplicate, coalesced away
    chain.enqueueSourceExtraction("proj_a", "src_2");
    expect(chain.pendingTriggerCount("proj_a")).toBe(3);

    release();
    await manual.done;

    await vi.waitFor(() => {
      expect(chain.pendingTriggerCount("proj_a")).toBe(0);
    });

    expect(startSourceExtraction).toHaveBeenCalledTimes(2);
    expect(startSourceExtraction).toHaveBeenNthCalledWith(
      1,
      "proj_a",
      "src_1",
      {
        runner,
      },
    );
    expect(startSourceExtraction).toHaveBeenNthCalledWith(
      2,
      "proj_a",
      "src_2",
      {
        runner,
      },
    );
    // One existence check chained after each of the two distinct passes.
    expect(startExistenceCheck).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce non-consecutive triggers with different source ids", async () => {
    const runner = createJobRunner();
    const startSourceExtraction = fakeExtraction(runner);
    const startExistenceCheck = fakeExistenceCheck(runner);
    const chain = createAutoChain({
      runner,
      startSourceExtraction,
      startExistenceCheck,
    });

    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manual = runner.submit(
      "proj_a",
      ["x"],
      (item) => item,
      async () => blocker,
      { kind: "verification" },
    );

    chain.enqueueSourceExtraction("proj_a", "src_1");
    chain.enqueueSourceExtraction("proj_a", "src_2");
    chain.enqueueSourceExtraction("proj_a", "src_1");

    release();
    await manual.done;

    await vi.waitFor(() => {
      expect(chain.pendingTriggerCount("proj_a")).toBe(0);
    });

    expect(startSourceExtraction).toHaveBeenCalledTimes(3);
  });
});

describe("createAutoChain: errors never kill the drain", () => {
  it("logs and continues past a trigger whose start-fn throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runner = createJobRunner();
    const startSourceExtraction = fakeExtractionThatFailsFor(
      runner,
      "src_fail",
    );
    const startExistenceCheck = fakeExistenceCheck(runner);
    const chain = createAutoChain({
      runner,
      startSourceExtraction,
      startExistenceCheck,
    });

    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manual = runner.submit(
      "proj_a",
      ["x"],
      (item) => item,
      async () => blocker,
      { kind: "verification" },
    );

    chain.enqueueSourceExtraction("proj_a", "src_fail");
    chain.enqueueSourceExtraction("proj_a", "src_ok");

    release();
    await manual.done;

    // The failed trigger never chains an existence check for itself, but
    // the successful one after it still does — wait for that chained call
    // rather than pendingTriggerCount, which can hit 0 the instant the
    // second trigger is dequeued, before it has actually run.
    await vi.waitFor(() => {
      expect(startExistenceCheck).toHaveBeenCalledTimes(1);
    });
    expect(startSourceExtraction).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(chain.pendingTriggerCount("proj_a")).toBe(0);
    });

    warn.mockRestore();
  });

  it("keeps draining a later project even if an earlier project's trigger throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runner = createJobRunner();
    const startSourceExtraction = fakeExtractionThatFailsFor(
      runner,
      "src_fail",
    );
    const startExistenceCheck = fakeExistenceCheck(runner);
    const chain = createAutoChain({
      runner,
      startSourceExtraction,
      startExistenceCheck,
    });

    chain.enqueueSourceExtraction("proj_a", "src_fail");
    chain.enqueueSourceExtraction("proj_b", "src_ok");

    // pendingTriggerCount alone is not a safe completion signal here: it
    // drops to 0 the instant a single-item queue is DEQUEUED, before the
    // dequeued trigger has actually finished (or even started failing) —
    // wait on the real side effects instead.
    await vi.waitFor(() => {
      expect(startSourceExtraction).toHaveBeenCalledWith("proj_a", "src_fail", {
        runner,
      });
      expect(startSourceExtraction).toHaveBeenCalledWith("proj_b", "src_ok", {
        runner,
      });
      expect(warn).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(startExistenceCheck).toHaveBeenCalledWith("proj_b", { runner });
    });

    warn.mockRestore();
  });
});

describe("createAutoChain: pendingTriggerCount", () => {
  it("reports the live backlog and clears once drained", async () => {
    const runner = createJobRunner();
    const startSourceExtraction = fakeExtraction(runner);
    const startExistenceCheck = fakeExistenceCheck(runner);
    const chain = createAutoChain({
      runner,
      startSourceExtraction,
      startExistenceCheck,
    });

    expect(chain.pendingTriggerCount("proj_a")).toBe(0);

    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manual = runner.submit(
      "proj_a",
      ["x"],
      (item) => item,
      async () => blocker,
      { kind: "verification" },
    );

    chain.enqueueSourceExtraction("proj_a", "src_1");
    chain.enqueueExistenceCheck("proj_a");
    expect(chain.pendingTriggerCount("proj_a")).toBe(2);
    // A different project's backlog is independent.
    expect(chain.pendingTriggerCount("proj_b")).toBe(0);

    release();
    await manual.done;

    await vi.waitFor(() => {
      expect(chain.pendingTriggerCount("proj_a")).toBe(0);
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
