import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../register";
import {
  InvalidProjectInputError,
  ProjectAlreadyExistsError,
  UnknownProjectError,
} from "./errors";
import {
  createProject,
  getProjectSummary,
  listProjects,
  readProject,
} from "./projects";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-pipeline-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("createProject", () => {
  it("creates a register with genesis event, schema file and config", async () => {
    const register = await createProject({
      id: "proj_reviewzeit",
      research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
      primaryCli: "claude",
      secondaryCli: "codex",
    });

    expect(register.project.id).toBe("proj_reviewzeit");
    expect(register.project.source_set_revision).toBe(1);
    expect(register.project_events).toHaveLength(1);
    expect(register.project_events[0]).toMatchObject({
      seq: 1,
      event: "project_created",
      actor: "human:lg",
    });
    expect(register.config.backends.secondary?.cli).toBe("codex");

    const projectDir = path.join(workspace, "proj_reviewzeit");
    expect(fs.existsSync(path.join(projectDir, "claims.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(projectDir, "schema", "claims.schema.json")),
    ).toBe(true);

    const verification = await RegisterStore.atDirectory(projectDir).verify();
    expect(verification.ok).toBe(true);
  });

  it("trims the research question and records it immutably", async () => {
    const register = await createProject({
      id: "proj_frage",
      research_question: "  Wirkt X?  ",
      primaryCli: "codex",
    });
    expect(register.project.research_question).toBe("Wirkt X?");
    expect(register.config.backends.secondary).toBeUndefined();
  });

  it("rejects an empty research question", async () => {
    await expect(
      createProject({
        id: "proj_leer",
        research_question: "   ",
        primaryCli: "claude",
      }),
    ).rejects.toBeInstanceOf(InvalidProjectInputError);
  });

  it("rejects malformed project ids", async () => {
    await expect(
      createProject({
        id: "Projekt 1",
        research_question: "Wirkt X?",
        primaryCli: "claude",
      }),
    ).rejects.toBeInstanceOf(InvalidProjectInputError);
  });

  it("rejects a secondary backend equal to the primary", async () => {
    await expect(
      createProject({
        id: "proj_doppelt",
        research_question: "Wirkt X?",
        primaryCli: "claude",
        secondaryCli: "claude",
      }),
    ).rejects.toBeInstanceOf(InvalidProjectInputError);
  });

  it("rejects the API spike backend as primary and as same-family second opinion (TMB-51)", async () => {
    vi.stubEnv("TMB_ENABLE_API_BACKEND", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    await expect(
      createProject({
        id: "proj_api_primary",
        research_question: "Wirkt X?",
        primaryCli: "anthropic-api",
      }),
    ).rejects.toThrow(/nur als sekundäres Backend/);
    await expect(
      createProject({
        id: "proj_api_family",
        research_question: "Wirkt X?",
        primaryCli: "claude",
        secondaryCli: "anthropic-api",
      }),
    ).rejects.toThrow(/Modellfamilie/);
    // The valid spike pairing: codex primary, anthropic-api secondary.
    const register = await createProject({
      id: "proj_api_ok",
      research_question: "Wirkt X?",
      primaryCli: "codex",
      secondaryCli: "anthropic-api",
    });
    expect(register.config.backends.secondary?.cli).toBe("anthropic-api");
    // Gate closed: the id is rejected like an unknown backend.
    vi.stubEnv("TMB_ENABLE_API_BACKEND", undefined);
    await expect(
      createProject({
        id: "proj_api_gated",
        research_question: "Wirkt X?",
        primaryCli: "codex",
        secondaryCli: "anthropic-api",
      }),
    ).rejects.toThrow(/Unbekanntes Backend/);
  });

  it("rejects a second creation under the same id", async () => {
    const input = {
      id: "proj_dup",
      research_question: "Wirkt X?",
      primaryCli: "claude" as const,
    };
    await createProject(input);
    await expect(createProject(input)).rejects.toBeInstanceOf(
      ProjectAlreadyExistsError,
    );
  });
});

describe("listProjects", () => {
  it("returns an empty list for a missing workspace root", async () => {
    vi.stubEnv("TMB_WORKSPACE", path.join(workspace, "does-not-exist"));
    expect(await listProjects()).toEqual([]);
  });

  it("summarizes projects ordered by last change, newest first", async () => {
    await createProject({
      id: "proj_alt",
      research_question: "Alte Frage?",
      primaryCli: "claude",
    });
    await createProject({
      id: "proj_neu",
      research_question: "Neue Frage?",
      primaryCli: "claude",
    });
    // A later mutation makes proj_alt the most recently changed project.
    const store = RegisterStore.forProject("proj_alt");
    const blob = store.blobs().put("Briefing-Text", "md");
    await store.transaction((tx) => {
      tx.recordBriefingImport({
        sha256: blob.sha256,
        blob_path: blob.blobPath,
        tool: "deep-research-x",
        actor: "human:lg",
      });
    });

    const summaries = await listProjects();
    expect(summaries.map((summary) => summary.id)).toEqual([
      "proj_alt",
      "proj_neu",
    ]);
    expect(summaries[0].briefing_imported).toBe(true);
    expect(summaries[0].total_claims).toBe(0);
    expect(summaries[0].claim_counts.pending_adjudication).toBe(0);
    expect(summaries[0].last_change_at).not.toBe(summaries[0].created_at);
  });

  it("skips foreign directories and corrupt registers", async () => {
    await createProject({
      id: "proj_ok",
      research_question: "Wirkt X?",
      primaryCli: "claude",
    });
    fs.mkdirSync(path.join(workspace, "kein projekt!"));
    const corrupt = path.join(workspace, "proj_kaputt");
    fs.mkdirSync(corrupt);
    fs.writeFileSync(path.join(corrupt, "claims.json"), "{ kaputt");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const summaries = await listProjects();
    expect(summaries.map((summary) => summary.id)).toEqual(["proj_ok"]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("getProjectSummary / readProject", () => {
  it("returns the summary of one project", async () => {
    await createProject({
      id: "proj_summary",
      research_question: "Wirkt X?",
      primaryCli: "claude",
    });
    const summary = await getProjectSummary("proj_summary");
    expect(summary.research_question).toBe("Wirkt X?");
    expect(summary.source_count).toBe(0);
    expect(summary.briefing_imported).toBe(false);

    const register = await readProject("proj_summary");
    expect(register.project.id).toBe("proj_summary");
  });

  it("throws UnknownProjectError for missing or malformed ids", async () => {
    await expect(getProjectSummary("proj_fehlt")).rejects.toBeInstanceOf(
      UnknownProjectError,
    );
    await expect(readProject("böse/../id")).rejects.toBeInstanceOf(
      UnknownProjectError,
    );
  });
});
