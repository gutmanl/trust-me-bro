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

describe("importBriefing — companion BibTeX file", () => {
  const BIB = [
    "@online{deepfact2026,",
    "  author = {Huang, Yukun},",
    "  title  = {DeepFact: Co-Evolving Benchmarks and Agents},",
    "  eprint = {2603.05912},",
    "  eprinttype = {arxiv},",
    "}",
    "",
    "@misc{mata2023avianca,",
    "  title = {Mata v. Avianca, Inc.},",
    "  year  = {2023},",
    "}",
  ].join("\n");

  const PANDOC = [
    "Agentische Recherchesysteme fabrizieren Belege [@deepfact2026].",
    "Ein Gericht sanktionierte eine solche Fabrikation [@mata2023avianca].",
  ].join("\n\n");

  it("freezes the DESUGARED text, not the Pandoc original", async () => {
    const meta = await importBriefing({
      projectId: "proj_briefing",
      content: PANDOC,
      tool: "pandoc",
      bibliography: BIB,
    });

    const store = RegisterStore.forProject("proj_briefing");
    const frozen = store.blobs().readText(meta.blob_path);
    expect(frozen).not.toContain("[@deepfact2026]");
    expect(frozen).toContain("fabrizieren Belege [^deepfact2026].");
    expect(frozen).toContain(
      "[^deepfact2026]: DeepFact: Co-Evolving Benchmarks and Agents. arXiv:2603.05912",
    );
    expect(frozen).toContain("[^mata2023avianca]: Mata v. Avianca, Inc.");
    expect((await store.verify()).ok).toBe(true);
  });

  it("never persists the .bib itself", async () => {
    await importBriefing({
      projectId: "proj_briefing",
      content: PANDOC,
      tool: "pandoc",
      bibliography: BIB,
    });
    const store = RegisterStore.forProject("proj_briefing");
    const files = fs.readdirSync(store.projectDir, { recursive: true });
    expect(
      files.filter((entry) => String(entry).endsWith(".bib")),
    ).toHaveLength(0);
  });

  it("returns the German rewrite report alongside the briefing", async () => {
    const meta = await importBriefing({
      projectId: "proj_briefing",
      content: PANDOC,
      tool: "pandoc",
      bibliography: BIB,
    });
    expect(meta.citationRewrite?.summary).toBe(
      "2 Zitationen aus 2 Einträgen in 2 Fußnoten überführt.",
    );
    expect(meta.citationRewrite?.footnoteKeys).toEqual([
      "deepfact2026",
      "mata2023avianca",
    ]);
    expect(meta.citationRewrite?.notes).toEqual([]);
  });

  it("reports a cited key the .bib does not know and leaves it in the text", async () => {
    const meta = await importBriefing({
      projectId: "proj_briefing",
      content: `${PANDOC}\n\nEin dritter Befund [@fehlt2026].`,
      tool: "pandoc",
      bibliography: BIB,
    });
    expect(meta.citationRewrite?.unresolvedKeys).toEqual(["fehlt2026"]);
    const store = RegisterStore.forProject("proj_briefing");
    expect(store.blobs().readText(meta.blob_path)).toContain("[@fehlt2026]");
  });

  it("carries no report at all when no bibliography was given", async () => {
    const meta = await importBriefing({
      projectId: "proj_briefing",
      content: BRIEFING,
      tool: "you.com Research",
    });
    expect(meta.citationRewrite).toBeUndefined();
  });

  it("treats a blank bibliography as none given", async () => {
    const meta = await importBriefing({
      projectId: "proj_briefing",
      content: PANDOC,
      tool: "pandoc",
      bibliography: "   \n  ",
    });
    expect(meta.citationRewrite).toBeUndefined();
    const store = RegisterStore.forProject("proj_briefing");
    expect(store.blobs().readText(meta.blob_path)).toBe(PANDOC);
  });
});
