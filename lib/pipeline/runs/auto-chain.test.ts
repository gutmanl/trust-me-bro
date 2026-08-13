import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceExtractionSummary } from "../extraction/run-source-extraction";
import type { ReferenceCaptureItemResult } from "../sources/reference-scan/run-reference-capture";
import type { ReferenceScanRunSummary } from "../sources/reference-scan/run-reference-scan";
import type { SourceCaptureItemResult } from "../sources/work-items/run-item";
import type { SourceCaptureWorkItem } from "../sources/work-items/types";
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

const fakeScanSummary: ReferenceScanRunSummary = {
  method: "regex",
  candidateCount: 2,
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

/** The reference chain's two start-fns, faked the same way: real submits
 * through the real runner, so "the scan and the capture cannot overlap" is
 * asserted against the actual single-writer rule rather than against a
 * promise ordering the fakes invented. */
function fakeReferenceScan(runner: JobRunner) {
  return vi.fn(
    async (
      projectId: string,
      deps?: { runner?: JobRunner },
    ): Promise<RunHandle<ReferenceScanRunSummary>> =>
      (deps?.runner ?? runner).submit(
        projectId,
        ["briefing"],
        () => "briefing",
        async () => fakeScanSummary,
        { kind: "reference_scan" },
      ),
  );
}

function fakeFailingReferenceScan() {
  return vi.fn(async (): Promise<RunHandle<ReferenceScanRunSummary>> => {
    throw new Error("boom on the scan");
  });
}

/** `candidateCount` items — 0 means the real thing's "nothing resolved
 * cleanly enough" answer, which starts no run at all and returns undefined. */
function fakeAutoReferenceCapture(runner: JobRunner, candidateCount: number) {
  return vi.fn(
    async (
      projectId: string,
      deps?: { runner?: JobRunner },
    ): Promise<RunHandle<ReferenceCaptureItemResult> | undefined> => {
      if (candidateCount === 0) {
        return undefined;
      }
      const items = Array.from(
        { length: candidateCount },
        (_unused, index) => `cand_${index}`,
      );
      return (deps?.runner ?? runner).submit(
        projectId,
        items,
        (id) => id,
        async (id) => ({
          candidateId: id,
          sourceId: `src_${id}`,
          message: "ok",
        }),
        { kind: "reference_capture" },
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

describe("createAutoChain: reference-scan → auto-capture chaining", () => {
  it("captures the resolved candidates right after the scan it follows", async () => {
    const runner = createJobRunner();
    const startReferenceScan = fakeReferenceScan(runner);
    const startAutoReferenceCapture = fakeAutoReferenceCapture(runner, 2);
    const chain = createAutoChain({
      runner,
      startReferenceScan,
      startAutoReferenceCapture,
    });

    chain.enqueueReferenceScan("proj_a");

    await vi.waitFor(() => {
      expect(startAutoReferenceCapture).toHaveBeenCalledTimes(1);
    });
    expect(startReferenceScan).toHaveBeenCalledWith("proj_a", { runner });
    expect(startAutoReferenceCapture).toHaveBeenCalledWith("proj_a", {
      runner,
    });
    const scanOrder = startReferenceScan.mock.invocationCallOrder[0];
    const captureOrder = startAutoReferenceCapture.mock.invocationCallOrder[0];
    expect(scanOrder).toBeLessThan(captureOrder);

    await vi.waitFor(() => {
      expect(chain.pendingTriggerCount("proj_a")).toBe(0);
    });
  });

  it("drains on past a scan that left nothing worth capturing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runner = createJobRunner();
    const startReferenceScan = fakeReferenceScan(runner);
    // No run at all: the honest signal for "every citation needs a human".
    const startAutoReferenceCapture = fakeAutoReferenceCapture(runner, 0);
    const startSourceExtraction = fakeExtraction(runner);
    const startExistenceCheck = fakeExistenceCheck(runner);
    const chain = createAutoChain({
      runner,
      startReferenceScan,
      startAutoReferenceCapture,
      startSourceExtraction,
      startExistenceCheck,
    });

    chain.enqueueReferenceScan("proj_a");
    chain.enqueueExistenceCheck("proj_a");

    // The empty capture is a normal outcome, not a failed trigger: whatever
    // was queued behind it still runs, and nothing is logged.
    await vi.waitFor(() => {
      expect(startExistenceCheck).toHaveBeenCalledTimes(1);
    });
    expect(startAutoReferenceCapture).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it("collapses a burst of publishes into one scan", async () => {
    const runner = createJobRunner();
    const startReferenceScan = fakeReferenceScan(runner);
    const startAutoReferenceCapture = fakeAutoReferenceCapture(runner, 1);
    const chain = createAutoChain({
      runner,
      startReferenceScan,
      startAutoReferenceCapture,
    });

    // Blocked behind an active run so all three enqueues land in the backlog
    // together, the same setup the extraction-coalescing test uses.
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

    chain.enqueueReferenceScan("proj_a");
    chain.enqueueReferenceScan("proj_a");
    chain.enqueueReferenceScan("proj_a");

    release();
    await manual.done;

    await vi.waitFor(() => {
      expect(startAutoReferenceCapture).toHaveBeenCalledTimes(1);
    });
    expect(startReferenceScan).toHaveBeenCalledTimes(1);
  });

  it("logs and continues past a scan whose start-fn throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runner = createJobRunner();
    const startReferenceScan = fakeFailingReferenceScan();
    const startAutoReferenceCapture = fakeAutoReferenceCapture(runner, 1);
    const startSourceExtraction = fakeExtraction(runner);
    const startExistenceCheck = fakeExistenceCheck(runner);
    const chain = createAutoChain({
      runner,
      startReferenceScan,
      startAutoReferenceCapture,
      startSourceExtraction,
      startExistenceCheck,
    });

    chain.enqueueReferenceScan("proj_a");
    chain.enqueueSourceExtraction("proj_a", "src_1");

    // A failed scan chains no capture of its own, but the trigger behind it
    // is untouched.
    await vi.waitFor(() => {
      expect(startExistenceCheck).toHaveBeenCalledTimes(1);
    });
    expect(startAutoReferenceCapture).not.toHaveBeenCalled();
    expect(startSourceExtraction).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();

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

describe("createAutoChain: source-capture work items", () => {
  function workItem(workItemId: string): SourceCaptureWorkItem {
    return {
      workItemId,
      origin: "manual",
      label: `Posten ${workItemId}`,
      request: {
        kind: "doi",
        sourceType: "peer_reviewed_publication",
        identifier: "10.1/x",
      },
    };
  }

  /** Capture-item fake through the real runner, gated per item so the tests
   * can observe the in-flight state between item_started and release. */
  function fakeSourceCaptureItem(runner: JobRunner) {
    const gates = new Map<string, () => void>();
    const fn = vi.fn(
      async (
        projectId: string,
        item: SourceCaptureWorkItem,
        deps?: { runner?: JobRunner },
      ): Promise<RunHandle<SourceCaptureItemResult>> =>
        (deps?.runner ?? runner).submit(
          projectId,
          [item],
          (entry) => entry.workItemId,
          async (entry) =>
            new Promise<SourceCaptureItemResult>((resolve) => {
              gates.set(entry.workItemId, () =>
                resolve({
                  workItemId: entry.workItemId,
                  sourceId: "src_fake",
                  message: "ok",
                }),
              );
            }),
          { kind: "source_capture" },
        ),
    );
    return {
      fn,
      release(workItemId: string) {
        gates.get(workItemId)?.();
        gates.delete(workItemId);
      },
    };
  }

  it("runs queued items sequentially and reports active/pending honestly", async () => {
    const runner = createJobRunner();
    const capture = fakeSourceCaptureItem(runner);
    const chain = createAutoChain({
      runner,
      startSourceExtraction: fakeExtraction(runner),
      startExistenceCheck: fakeExistenceCheck(runner),
      startSourceCaptureItem: capture.fn,
    });

    chain.enqueueSourceCapture("proj_a", workItem("wi_1"));
    chain.enqueueSourceCapture("proj_a", workItem("wi_2"));

    // First item in flight: it is the active one, only the second waits.
    await vi.waitFor(() => {
      expect(chain.activeCaptureItem("proj_a")?.workItemId).toBe("wi_1");
    });
    expect(
      chain.pendingCaptureItems("proj_a").map((item) => item.workItemId),
    ).toEqual(["wi_2"]);

    capture.release("wi_1");
    await vi.waitFor(() => {
      expect(chain.activeCaptureItem("proj_a")?.workItemId).toBe("wi_2");
    });
    expect(chain.pendingCaptureItems("proj_a")).toEqual([]);

    capture.release("wi_2");
    await vi.waitFor(() => {
      expect(chain.activeCaptureItem("proj_a")).toBeUndefined();
    });
    expect(capture.fn).toHaveBeenCalledTimes(2);
  });

  it("clears the active item even when the start-fn throws", async () => {
    const runner = createJobRunner();
    const failing = vi.fn(async () => {
      throw new Error("capture start failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chain = createAutoChain({
      runner,
      startSourceExtraction: fakeExtraction(runner),
      startExistenceCheck: fakeExistenceCheck(runner),
      startSourceCaptureItem: failing,
    });

    chain.enqueueSourceCapture("proj_a", workItem("wi_boom"));

    await vi.waitFor(() => {
      expect(failing).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(chain.activeCaptureItem("proj_a")).toBeUndefined();
    });
    expect(chain.pendingTriggerCount("proj_a")).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("coalesces only same-id bursts, never distinct work items", async () => {
    const runner = createJobRunner();
    const capture = fakeSourceCaptureItem(runner);
    const chain = createAutoChain({
      runner,
      startSourceExtraction: fakeExtraction(runner),
      startExistenceCheck: fakeExistenceCheck(runner),
      startSourceCaptureItem: capture.fn,
    });

    // Blocks the project so all triggers queue up before draining.
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

    chain.enqueueSourceCapture("proj_a", workItem("wi_a"));
    chain.enqueueSourceCapture("proj_a", workItem("wi_a"));
    chain.enqueueSourceCapture("proj_a", workItem("wi_b"));
    expect(
      chain.pendingCaptureItems("proj_a").map((item) => item.workItemId),
    ).toEqual(["wi_a", "wi_a", "wi_b"]);

    release();
    await manual.done;

    await vi.waitFor(() => {
      expect(chain.activeCaptureItem("proj_a")?.workItemId).toBe("wi_a");
    });
    capture.release("wi_a");
    await vi.waitFor(() => {
      expect(chain.activeCaptureItem("proj_a")?.workItemId).toBe("wi_b");
    });
    capture.release("wi_b");
    await vi.waitFor(() => {
      expect(chain.pendingTriggerCount("proj_a")).toBe(0);
    });
    // wi_a ran once (duplicate coalesced), wi_b ran once.
    expect(capture.fn).toHaveBeenCalledTimes(2);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
