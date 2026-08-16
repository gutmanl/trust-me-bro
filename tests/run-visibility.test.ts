import { describe, expect, it, vi } from "vitest";

import { createActivityLedger } from "../lib/pipeline/runs/activity-ledger";
import {
  createAutoChain,
  hasCaptureInFlight,
} from "../lib/pipeline/runs/auto-chain";
import {
  cancelActivity,
  describeBlockingActivity,
} from "../lib/pipeline/runs/control";
import { createJobRunner } from "../lib/pipeline/runs/job-runner";
import { getProjectActivity } from "../lib/pipeline/runs/status";
import type { SourceCaptureWorkItem } from "../lib/pipeline/sources/work-items/types";

/**
 * The incident, replayed against the fixed system (run visibility).
 *
 * Before: a chain trigger that never settled wedged the project — the
 * runner reported idle (status bar empty), `hasCaptureInFlight` reported
 * busy (corrections refused), no cancel existed anywhere, and only a
 * process restart cleared it. This file asserts the invariant that closed
 * it: NOTHING that can block future work may be invisible or uncancellable.
 */

function fakeRunHandle(kind: string) {
  return {
    runId: `run-${kind}`,
    projectId: "p",
    kind,
    startedAt: new Date().toISOString(),
    isActive: () => false,
    eventsSoFar: () => [],
    subscribe: () => () => {},
    controlState: () => "running" as const,
    requestPause: () => false,
    resume: () => false,
    requestCancel: () => false,
    done: Promise.resolve({ succeeded: 1, failed: 0 }),
  };
}

function workItem(workItemId: string): SourceCaptureWorkItem {
  return {
    workItemId,
    origin: "correction",
    label: "richtiges Paper",
    request: {
      kind: "upload",
      sourceType: "peer_reviewed_publication",
      targetSourceId: "src_alrajeh2013",
    },
  };
}

describe("run visibility: the wedged-trigger incident cannot recur", () => {
  it("a never-settling trigger is visible, blamable and cancellable — and cancel unblocks the queue", async () => {
    const ledger = createActivityLedger();
    const runner = createJobRunner({ ledger });
    const captured: string[] = [];
    const chain = createAutoChain({
      runner,
      ledger,
      startExistenceCheck: (async () =>
        fakeRunHandle("existence_check")) as never,
      listRepairEvaluationSources: async () => ["src_alrajeh2013"],
      // The wedge: an evaluation that never settles.
      evaluateSourceRepair: () => new Promise<void>(() => {}),
      startSourceCaptureItem: (async (
        _projectId: string,
        item: SourceCaptureWorkItem,
      ) => {
        captured.push(item.workItemId);
        return fakeRunHandle("source_capture");
      }) as never,
      // The successful correction fans out real follow-ups; faked so the
      // test needs no project on disk.
      runBriefingSubstitution: async () => {},
      runFuzzyReanchorSweep: async () => {},
    });

    chain.enqueueExistenceCheck("p");
    // Let the drain reach the wedged evaluation.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // The user's correction arrives behind the wedge — the incident's shape.
    chain.enqueueSourceCapture("p", workItem("wi_fix"));
    await new Promise((resolve) => setTimeout(resolve, 25));

    // 1. VISIBLE: the unified activity names the wedge; the old
    //    runner-only view would have said idle.
    const activity = getProjectActivity("p", { runner, chain });
    expect(activity).toMatchObject({
      source: "trigger",
      kind: "source_repair_evaluation",
    });
    // 2. BLAMABLE: a blocked action's message has a named blocker.
    expect(describeBlockingActivity("p", { ledger })?.description).toContain(
      "Automatische Reparatur",
    );
    // 3. The guard still (rightly) refuses a second correction…
    expect(
      hasCaptureInFlight(
        "p",
        (item) => item.targetSourceId === "src_alrajeh2013",
        chain,
      ),
    ).toBe(true);

    // 4. …and CANCEL exists and unblocks: the drain abandons the wedge and
    //    the queued correction proceeds — no restart, ever.
    cancelActivity("p", { ledger });
    await vi.waitFor(() => {
      expect(captured).toEqual(["wi_fix"]);
    });
    // Once the chain settles (the correction's own follow-ups included),
    // the seat is genuinely free again.
    await vi.waitFor(() => {
      expect(getProjectActivity("p", { runner, chain })).toBeNull();
      expect(chain.pendingTriggerCount("p")).toBe(0);
    });
  });

  it("the deadline abandons a wedged trigger even with nobody watching", async () => {
    const ledger = createActivityLedger();
    const runner = createJobRunner({ ledger });
    const captured: string[] = [];
    const chain = createAutoChain({
      runner,
      ledger,
      triggerDeadlineMs: 30,
      startExistenceCheck: (async () =>
        fakeRunHandle("existence_check")) as never,
      listRepairEvaluationSources: async () => ["src_x"],
      evaluateSourceRepair: () => new Promise<void>(() => {}),
      startSourceCaptureItem: (async (
        _projectId: string,
        item: SourceCaptureWorkItem,
      ) => {
        captured.push(item.workItemId);
        return fakeRunHandle("source_capture");
      }) as never,
    });

    chain.enqueueExistenceCheck("p");
    await new Promise((resolve) => setTimeout(resolve, 10));
    chain.enqueueSourceCapture("p", workItem("wi_after_deadline"));

    // Past the deadline the queue moves on by itself.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(captured).toEqual(["wi_after_deadline"]);
  });

  it("a queued item is removable, and the guard frees up with it", async () => {
    const ledger = createActivityLedger();
    const runner = createJobRunner({ ledger });
    const chain = createAutoChain({
      runner,
      ledger,
      startExistenceCheck: (async () =>
        fakeRunHandle("existence_check")) as never,
      listRepairEvaluationSources: async () => ["src_x"],
      evaluateSourceRepair: () => new Promise<void>(() => {}),
    });
    chain.enqueueExistenceCheck("p");
    await new Promise((resolve) => setTimeout(resolve, 10));
    chain.enqueueSourceCapture("p", workItem("wi_stale"));

    const matches = (item: { targetSourceId?: string }) =>
      item.targetSourceId === "src_alrajeh2013";
    expect(hasCaptureInFlight("p", matches, chain)).toBe(true);
    expect(chain.removeQueuedCapture("p", "wi_stale")).toBe(true);
    expect(hasCaptureInFlight("p", matches, chain)).toBe(false);
    // A stale second click is a no-op, never an error.
    expect(chain.removeQueuedCapture("p", "wi_stale")).toBe(false);
  });
});
