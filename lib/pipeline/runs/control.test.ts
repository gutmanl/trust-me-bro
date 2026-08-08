import { describe, expect, it } from "vitest";

import { NoActiveRunError } from "../errors";
import { cancelRun, pauseRun, resumeRun } from "./control";
import { createJobRunner } from "./job-runner";

function blockedRun(runner = createJobRunner()) {
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = runner.submit(
    "proj_a",
    ["eins", "zwei"],
    (item) => item,
    async (item) => {
      if (item === "eins") {
        await blocker;
      }
      return item;
    },
    { kind: "verification" },
  );
  return { runner, handle, release };
}

describe("run control use-cases (TMB-50)", () => {
  it("pauses and resumes the addressed run kind", async () => {
    const { runner, handle, release } = blockedRun();
    pauseRun("proj_a", "verification", { runner });
    expect(handle.controlState()).toBe("pausing");
    resumeRun("proj_a", "verification", { runner });
    expect(handle.controlState()).toBe("running");
    release();
    await handle.done;
  });

  it("cancels the addressed run", async () => {
    const { runner, handle, release } = blockedRun();
    cancelRun("proj_a", "verification", { runner });
    release();
    await handle.done;
    expect(handle.controlState()).toBe("cancelled");
  });

  it("throws NoActiveRunError when nothing is running", () => {
    const runner = createJobRunner();
    expect(() => pauseRun("proj_a", "verification", { runner })).toThrow(
      NoActiveRunError,
    );
  });

  it("throws NoActiveRunError for a different kind", async () => {
    const { runner, handle, release } = blockedRun();
    expect(() => pauseRun("proj_a", "extraction", { runner })).toThrow(
      NoActiveRunError,
    );
    release();
    await handle.done;
  });

  it("throws NoActiveRunError once the run finished", async () => {
    const { runner, handle, release } = blockedRun();
    release();
    await handle.done;
    expect(() => cancelRun("proj_a", "verification", { runner })).toThrow(
      NoActiveRunError,
    );
  });
});
