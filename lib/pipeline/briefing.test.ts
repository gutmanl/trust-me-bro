import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../register";
import { getBriefing, importBriefing } from "./briefing";
import {
  BriefingAlreadyImportedError,
  InvalidBriefingInputError,
  UnknownProjectError,
} from "./errors";
import { createProject } from "./projects";

const BRIEFING = [
  "LLM-gestützte Code-Reviews verändern den Reviewprozess.",
  "Die mediane Reviewzeit sinkt laut einer Studie um 55 %.",
].join("\n\n");

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-briefing-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: "proj_briefing",
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("importBriefing", () => {
  it("freezes the original as blob and records import + chain event", async () => {
    const meta = await importBriefing({
      projectId: "proj_briefing",
      content: BRIEFING,
      tool: "you.com Research",
    });

    expect(meta.tool).toBe("you.com Research");
    expect(meta.blob_path).toContain(meta.sha256);

    const store = RegisterStore.forProject("proj_briefing");
    const register = await store.read();
    expect(register.project.briefing_import).toEqual(meta);
    expect(register.project_events.map((event) => event.event)).toEqual([
      "project_created",
      "briefing_imported",
    ]);
    expect(store.blobs().readText(meta.blob_path)).toBe(BRIEFING);
    expect((await store.verify()).ok).toBe(true);
    // The projection exists as soon as the briefing is frozen.
    expect(fs.existsSync(path.join(store.projectDir, "briefing.md"))).toBe(
      true,
    );
  });

  it("returns the briefing text and metadata via getBriefing", async () => {
    expect(await getBriefing("proj_briefing")).toBeNull();
    await importBriefing({
      projectId: "proj_briefing",
      content: BRIEFING,
      tool: "deep-research-x",
    });
    const briefing = await getBriefing("proj_briefing");
    expect(briefing?.text).toBe(BRIEFING);
    expect(briefing?.meta.tool).toBe("deep-research-x");
  });

  it("rejects empty content and missing tool", async () => {
    await expect(
      importBriefing({ projectId: "proj_briefing", content: "  ", tool: "x" }),
    ).rejects.toBeInstanceOf(InvalidBriefingInputError);
    await expect(
      importBriefing({
        projectId: "proj_briefing",
        content: BRIEFING,
        tool: " ",
      }),
    ).rejects.toBeInstanceOf(InvalidBriefingInputError);
  });

  it("rejects a user-supplied tool that claims the reserved research prefix", async () => {
    // The independence notice keys on `trustmebro-research/<backend>`; a
    // manual import must not be able to forge that provenance.
    await expect(
      importBriefing({
        projectId: "proj_briefing",
        content: BRIEFING,
        tool: "trustmebro-research/claude",
      }),
    ).rejects.toBeInstanceOf(InvalidBriefingInputError);
    // Nothing was written: the guard runs before the transaction.
    expect(await getBriefing("proj_briefing")).toBeNull();
  });

  it("rejects a second import and leaves the register unchanged", async () => {
    await importBriefing({
      projectId: "proj_briefing",
      content: BRIEFING,
      tool: "deep-research-x",
    });
    const before = fs.readFileSync(
      RegisterStore.forProject("proj_briefing").claimsPath,
      "utf8",
    );

    await expect(
      importBriefing({
        projectId: "proj_briefing",
        content: "Anderer Text.",
        tool: "anderes-tool",
      }),
    ).rejects.toBeInstanceOf(BriefingAlreadyImportedError);

    const after = fs.readFileSync(
      RegisterStore.forProject("proj_briefing").claimsPath,
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("throws UnknownProjectError for a missing project", async () => {
    await expect(
      importBriefing({ projectId: "proj_fehlt", content: BRIEFING, tool: "x" }),
    ).rejects.toBeInstanceOf(UnknownProjectError);
  });
});
