import { describe, expect, it } from "vitest";

import { createJobRunner } from "./job-runner";
import { getActiveRun, getActiveRunHandle } from "./status";

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe("getActiveRun", () => {
  it("is null when nothing is running for the project", () => {
    const runner = createJobRunner();
    expect(getActiveRun("proj_a", { runner })).toBeNull();
    expect(getActiveRunHandle("proj_a", { runner })).toBeUndefined();
  });

  it("reports kind, phase and n/m progress of the live run", async () => {
    const runner = createJobRunner({ generateRunId: () => "run-x" });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = runner.submit(
      "proj_a",
      [0, 1],
      (item) => String(item),
      async (item) => {
        if (item === 1) {
          await blocked;
        }
        return item;
      },
      { kind: "extraction" },
    );
    // Let item 0 finish and item 1 start (and block).
    await tick();

    expect(getActiveRunHandle("proj_a", { runner })).toBe(handle);
    expect(getActiveRun("proj_a", { runner })).toEqual({
      runId: "run-x",
      kind: "extraction",
      phase: "running",
      completed: 1,
      total: 2,
    });

    release();
    await handle.done;
    // Finished → no active run.
    expect(getActiveRun("proj_a", { runner })).toBeNull();
    expect(getActiveRunHandle("proj_a", { runner })).toBeUndefined();
  });

  it("exposes per-candidate capture outcomes after a run (server-derived feedback)", async () => {
    const { getReferenceCaptureOutcomes } =
      await import("../sources/reference-scan/run-reference-capture");
    const runner = createJobRunner();
    const handle = runner.submit(
      "proj_c",
      ["cand_a", "cand_b"],
      (item) => item,
      async (item) => {
        if (item === "cand_b") {
          throw new Error("Landing-Page statt PDF");
        }
        return { ok: true };
      },
      { kind: "reference_capture" },
    );
    await handle.done;

    expect(getReferenceCaptureOutcomes("proj_c", { runner })).toEqual([
      { candidateId: "cand_a", status: "ok" },
      {
        candidateId: "cand_b",
        status: "error",
        error: "Landing-Page statt PDF",
      },
    ]);
    // No run for an untouched project → empty, never a throw.
    expect(getReferenceCaptureOutcomes("proj_none", { runner })).toEqual([]);
  });

  it("reports kind null for a kind-less run", async () => {
    const runner = createJobRunner();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = runner.submit(
      "proj_b",
      [0],
      (item) => String(item),
      async () => blocked,
    );
    await tick();
    expect(getActiveRun("proj_b", { runner })?.kind).toBeNull();
    release();
    await handle.done;
  });
});
