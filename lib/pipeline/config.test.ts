import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../register";
import { updateProjectConfig } from "./config";
import { InvalidProjectInputError, RunActiveError } from "./errors";
import { createProject } from "./projects";
import { createJobRunner } from "./runs/job-runner";

const PROJECT = "proj_einstellungen";

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-config-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
    secondaryCli: "codex",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const CURRENT = {
  rubricVersion: "se-evidence-rubric-v1",
  adjudicationSampleRate: 0.1,
  maxRepairCycles: 2,
  primaryCli: "claude" as const,
  secondaryCli: "codex" as const,
  secondOpinion: { confidenceThreshold: 0.8, onRelationNotSupports: true },
};

describe("updateProjectConfig", () => {
  it("records an effective change as config_changed event with before/after", async () => {
    const result = await updateProjectConfig(PROJECT, {
      ...CURRENT,
      adjudicationSampleRate: 0.25,
      primaryCli: "codex",
      secondaryCli: "claude",
    });
    expect(result.event).not.toBeNull();
    expect(result.changedFields).toEqual([
      "adjudication_sample_rate: 0.1 → 0.25",
      'backends.primary: "claude" → "codex"',
      'backends.secondary: "codex" → "claude"',
    ]);

    const store = RegisterStore.forProject(PROJECT);
    const register = await store.read();
    expect(register.config.adjudication_sample_rate).toBe(0.25);
    expect(register.config.backends.primary).toEqual({
      cli: "codex",
      model_family: "openai",
    });
    const event = register.project_events.find(
      (candidate) => candidate.event === "config_changed",
    );
    expect(event?.actor).toBe("human:lg");
    expect(event?.reason).toContain("adjudication_sample_rate");
    expect(event?.config_change?.previous.adjudication_sample_rate).toBe(0.1);
    expect(event?.config_change?.next.adjudication_sample_rate).toBe(0.25);
    expect((await store.verify()).ok).toBe(true);
  });

  it("drops second_opinion when the secondary backend is removed", async () => {
    const result = await updateProjectConfig(PROJECT, {
      ...CURRENT,
      secondaryCli: undefined,
      secondOpinion: undefined,
    });
    expect(result.config.backends.secondary).toBeUndefined();
    expect(result.config.second_opinion).toBeUndefined();
    expect(result.changedFields).toEqual([
      'backends.secondary: "codex" → –',
      "second_opinion.confidence_threshold: 0.8 → –",
      "second_opinion.on_relation_not_supports: true → –",
    ]);
  });

  it("is a no-op without an event when nothing changed", async () => {
    const before = await RegisterStore.forProject(PROJECT).read();
    const result = await updateProjectConfig(PROJECT, CURRENT);
    expect(result.event).toBeNull();
    expect(result.changedFields).toEqual([]);
    const after = await RegisterStore.forProject(PROJECT).read();
    expect(after).toEqual(before);
  });

  it("rejects both backends on the same model family (divergence rule)", async () => {
    await expect(
      updateProjectConfig(PROJECT, { ...CURRENT, secondaryCli: "claude" }),
    ).rejects.toBeInstanceOf(InvalidProjectInputError);
  });

  it("rejects out-of-range values and unknown rubric versions", async () => {
    await expect(
      updateProjectConfig(PROJECT, {
        ...CURRENT,
        adjudicationSampleRate: 1.5,
      }),
    ).rejects.toBeInstanceOf(InvalidProjectInputError);
    await expect(
      updateProjectConfig(PROJECT, { ...CURRENT, maxRepairCycles: 0 }),
    ).rejects.toBeInstanceOf(InvalidProjectInputError);
    await expect(
      updateProjectConfig(PROJECT, {
        ...CURRENT,
        rubricVersion: "gibts-nicht-v9",
      }),
    ).rejects.toBeInstanceOf(InvalidProjectInputError);
  });

  it("rejects edits while a run is active", async () => {
    const runner = createJobRunner();
    runner.submit(
      PROJECT,
      ["item"],
      (item) => item,
      () => new Promise((resolve) => setTimeout(() => resolve("ok"), 50)),
      { kind: "verification" },
    );
    await expect(
      updateProjectConfig(
        PROJECT,
        { ...CURRENT, adjudicationSampleRate: 0.5 },
        { runner },
      ),
    ).rejects.toBeInstanceOf(RunActiveError);
  });
});
