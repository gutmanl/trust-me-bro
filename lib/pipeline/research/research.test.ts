import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockBackend, Orchestrator } from "../../adapters";
import { RegisterStore } from "../../register";
import { ResearchPreconditionError } from "../errors";
import { createProject } from "../projects";
import { createJobRunner } from "../runs/job-runner";
import { deriveResearchState } from "./derive-state";
import { getBriefingIndependence } from "./independence";
import { getResearchState, startResearch } from "./run-research";

/**
 * TMB-55: the initial research produces the briefing that everything
 * downstream verifies. Two properties matter beyond "it runs": the result
 * goes through the ORDINARY freeze path (so there is no second way briefing
 * truth enters the register), and the provenance is machine-readable (so the
 * independence notice has something to compare).
 */

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-research-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function testOrchestrator(): Orchestrator {
  return new Orchestrator({
    backends: [createMockBackend({ id: "mock", model: "mock-1" })],
    traceSink: { write: async () => {} },
    gate: { run: (fn) => fn() },
    policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    sleep: async () => {},
  });
}

async function runResearch(projectId: string) {
  const handle = await startResearch(projectId, {
    orchestrator: testOrchestrator(),
    runner: createJobRunner(),
  });
  return handle.done;
}

describe("startResearch", () => {
  it("freezes the generated briefing through the ordinary import path", async () => {
    await createProject({
      id: "proj_research",
      research_question: "Wirkt X?",
      primaryCli: "mock",
    });

    expect(await runResearch("proj_research")).toEqual({
      succeeded: 1,
      failed: 0,
    });

    const register = await RegisterStore.forProject("proj_research").read();
    const briefing = register.project.briefing_import;
    expect(briefing).toBeDefined();
    // Hashed and blob-backed exactly like a manual import — not a second,
    // parallel route into the register.
    expect(briefing?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      RegisterStore.forProject("proj_research")
        .blobs()
        .readText(briefing!.blob_path),
    ).toContain("Mock-Briefing");
  });

  it("records provenance in the binding trustmebro-research/<backend> form", async () => {
    await createProject({
      id: "proj_prov",
      research_question: "Wirkt X?",
      primaryCli: "mock",
    });
    await runResearch("proj_prov");

    const register = await RegisterStore.forProject("proj_prov").read();
    // The exact format is load-bearing: the independence notice parses the
    // backend id back out of it.
    expect(register.project.briefing_import?.tool).toBe(
      "trustmebro-research/mock",
    );
  });

  it("brackets the run with its own event pair", async () => {
    await createProject({
      id: "proj_bracket",
      research_question: "Wirkt X?",
      primaryCli: "mock",
    });
    await runResearch("proj_bracket");

    const register = await RegisterStore.forProject("proj_bracket").read();
    const events = register.project_events.map((event) => event.event);
    expect(events).toContain("research_run_started");
    expect(events).toContain("research_run_completed");
    // Run state is derivable from the register alone, with no run store.
    expect(getResearchState("proj_bracket", register).status).toBe("completed");
  });

  it("refuses to run when a briefing already exists", async () => {
    await createProject({
      id: "proj_twice",
      research_question: "Wirkt X?",
      primaryCli: "mock",
    });
    await runResearch("proj_twice");
    await expect(runResearch("proj_twice")).rejects.toBeInstanceOf(
      ResearchPreconditionError,
    );
  });

  it("leaves the register verifiable", async () => {
    await createProject({
      id: "proj_chain",
      research_question: "Wirkt X?",
      primaryCli: "mock",
    });
    await runResearch("proj_chain");
    const verification = await RegisterStore.forProject("proj_chain").verify();
    expect(verification.ok).toBe(true);
  });
});

describe("deriveResearchState", () => {
  const base = {
    schema_version: "1.0.0",
    project: { id: "proj_x", research_question: "Q", created_at: "2026-01-01" },
    config: {},
    sources: [],
    claims: [],
    project_events: [],
  } as unknown as Parameters<typeof deriveResearchState>[0];

  it("reports not_started on an untouched project", () => {
    expect(deriveResearchState(base, false).status).toBe("not_started");
  });

  it("reports running while a run is live", () => {
    expect(deriveResearchState(base, true).status).toBe("running");
  });

  it("reports interrupted for an unclosed bracket", () => {
    const register = structuredClone(base);
    register.project_events = [
      { event: "research_run_started", at: "t1", seq: 1 },
    ] as unknown as typeof register.project_events;
    expect(deriveResearchState(register, false).status).toBe("interrupted");
  });

  it("distinguishes a closed bracket with a briefing from one without", () => {
    const register = structuredClone(base);
    register.project_events = [
      { event: "research_run_started", at: "t1", seq: 1 },
      { event: "research_run_completed", at: "t2", seq: 2, reason: "r" },
    ] as unknown as typeof register.project_events;
    // Closed but empty-handed: the run ended without producing a briefing.
    expect(deriveResearchState(register, false).status).toBe("failed");

    register.project.briefing_import = {
      tool: "trustmebro-research/mock",
    } as unknown as NonNullable<typeof register.project.briefing_import>;
    expect(deriveResearchState(register, false).status).toBe("completed");
  });
});

describe("getBriefingIndependence", () => {
  function registerWith(tool: string | undefined, primaryCli: string) {
    return {
      project: {
        briefing_import: tool === undefined ? undefined : { tool },
      },
      config: { backends: { primary: { cli: primaryCli } } },
    } as unknown as Parameters<typeof getBriefingIndependence>[0];
  }

  it("flags a shared model family for a self-researched briefing", () => {
    const result = getBriefingIndependence(
      registerWith("trustmebro-research/claude", "claude"),
    );
    expect(result).toMatchObject({
      selfResearched: true,
      sharedModelFamily: true,
      researchBackend: "claude",
      modelFamily: "anthropic",
    });
  });

  it("compares FAMILIES, not backend ids — the trap of this feature", () => {
    // claude and anthropic-api are different ids of the SAME family; an id
    // comparison would miss exactly this case.
    expect(
      getBriefingIndependence(
        registerWith("trustmebro-research/claude", "anthropic-api"),
      ).sharedModelFamily,
    ).toBe(true);
  });

  it("reports independence when the families differ", () => {
    expect(
      getBriefingIndependence(
        registerWith("trustmebro-research/claude", "codex"),
      ),
    ).toMatchObject({ selfResearched: true, sharedModelFamily: false });
  });

  it("says nothing about an externally imported briefing", () => {
    // The application does not know what researched it and must not
    // suggest otherwise.
    expect(
      getBriefingIndependence(registerWith("deep-research-x", "claude")),
    ).toEqual({ selfResearched: false, sharedModelFamily: false });
    expect(getBriefingIndependence(registerWith(undefined, "claude"))).toEqual({
      selfResearched: false,
      sharedModelFamily: false,
    });
  });
});
