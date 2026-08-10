import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../register";
import { createDemoProject, DEMO_PROJECT_ID } from "./demo";
import { ProjectAlreadyExistsError } from "./errors";
import { getProjectSummary, isDemoProject } from "./projects";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-demo-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("createDemoProject", () => {
  it("seeds a register that verifies clean against its own hash chain", async () => {
    await createDemoProject();
    // The same check `tmb verify` runs: if the seeder wrote anything the
    // chain cannot account for, this fails.
    const verification =
      await RegisterStore.forProject(DEMO_PROJECT_ID).verify();
    expect(verification.errors).toEqual([]);
    expect(verification.ok).toBe(true);
  });

  it("is a demo project and says so in its summary", async () => {
    const register = await createDemoProject();
    expect(register.project.id).toBe(DEMO_PROJECT_ID);
    expect(isDemoProject(register.config)).toBe(true);
    expect((await getProjectSummary(DEMO_PROJECT_ID)).is_demo).toBe(true);
  });

  it("spans different terminal states so the workshop has something to show", async () => {
    const register = await createDemoProject();
    const byStatus = new Map(
      register.claims.map((claim) => [claim.id, claim.status]),
    );
    expect(byStatus.get("clm_demo1")).toBe("confirmed");
    // Non-empty adjudication queue: without it the reviewer has nothing to
    // decide and the demo dead-ends.
    expect(byStatus.get("clm_demo2")).toBe("pending_adjudication");
    expect(byStatus.get("clm_demo3")).toBe("contested");
    expect(register.sources).toHaveLength(2);
    expect(register.project.briefing_import).toBeDefined();
  });

  it("marks every seeded entry with a demo_seed actor (D1: chained provenance)", async () => {
    const register = await createDemoProject();
    const seeded: string[] = [
      ...register.claims.flatMap((claim) =>
        claim.history.map((entry) => entry.actor),
      ),
      // The genesis project_created event is excluded: createProject writes
      // it as the real user, who really did create the project.
      ...register.project_events
        .filter((event) => event.event !== "project_created")
        .map((event) => event.actor),
    ];
    expect(seeded.length).toBeGreaterThan(0);
    for (const actor of seeded) {
      expect(actor).toMatch(/^(system|human):demo_seed$/);
    }
    // The provenance survives export and `tmb verify` because it is part of
    // the hashed history, not a flag beside it.
    expect(seeded).toContain("system:demo_seed");
    expect(seeded).toContain("human:demo_seed");
  });

  it("refuses a second seeding through the existing already-exists path", async () => {
    await createDemoProject();
    await expect(createDemoProject()).rejects.toBeInstanceOf(
      ProjectAlreadyExistsError,
    );
  });
});
