import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../register";
import type { Claim } from "../../register";
import { AdjudicationPreconditionError } from "../errors";
import { createProject } from "../projects";
import { decideClaim } from "./decide";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-adjudication-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** Creates a project with one claim in pending_adjudication (no evidence). */
async function projectWithOpenClaim(): Promise<string> {
  const projectId = "proj_adjudikation";
  await createProject({
    id: projectId,
    research_question: "Frage?",
    primaryCli: "claude",
  });
  const store = RegisterStore.forProject(projectId);
  await store.transaction((tx) => {
    tx.addClaim({
      claim: {
        id: "clm_0001",
        text: "Unbelegter Leitsatz.",
        claim_type: "quantitative_finding",
        briefing_anchor: "p1",
        provenance: {
          tool: "claude",
          model: "claude-sonnet-5",
          extracted_at: "2026-08-08T09:00:00Z",
          search_path: "briefing",
        },
        evidence: [],
      } as Omit<Claim, "status" | "history">,
      actor: "system:extraction",
      reason: "Ohne Fundstelle extrahiert.",
    });
  });
  return projectId;
}

describe("decideClaim", () => {
  it("confirms with empty categories and versions the decision", async () => {
    const projectId = await projectWithOpenClaim();
    const entry = await decideClaim(projectId, "clm_0001", {
      categories: [],
      durationS: 42,
    });
    expect(entry.to_status).toBe("confirmed");
    expect(entry.decision).toMatchObject({
      categories: [],
      reviewed_evidence_ids: [],
      duration_s: 42,
    });
    const register = await RegisterStore.forProject(projectId).read();
    expect(register.claims[0].status).toBe("confirmed");
    expect((await RegisterStore.forProject(projectId).verify()).ok).toBe(true);
  });

  it("complains with multi-select categories into contested", async () => {
    const projectId = await projectWithOpenClaim();
    const entry = await decideClaim(projectId, "clm_0001", {
      categories: ["wording_not_in_source", "source_outdated"],
      justification: "Wortlaut fehlt, Quelle von 2019.",
      durationS: 77,
    });
    expect(entry.to_status).toBe("contested");
    expect(entry.decision?.categories).toEqual([
      "wording_not_in_source",
      "source_outdated",
    ]);
    expect(entry.reason).toContain("Wortlaut fehlt, Quelle von 2019.");
  });

  it("rejects other without justification", async () => {
    const projectId = await projectWithOpenClaim();
    await expect(
      decideClaim(projectId, "clm_0001", {
        categories: ["other"],
        justification: "   ",
        durationS: 5,
      }),
    ).rejects.toThrow(AdjudicationPreconditionError);
  });

  it("rejects claims that are not awaiting adjudication", async () => {
    const projectId = await projectWithOpenClaim();
    await decideClaim(projectId, "clm_0001", { categories: [], durationS: 1 });
    await expect(
      decideClaim(projectId, "clm_0001", { categories: [], durationS: 1 }),
    ).rejects.toThrow(AdjudicationPreconditionError);
  });

  it("rejects unknown claims and unmeasurable durations", async () => {
    const projectId = await projectWithOpenClaim();
    await expect(
      decideClaim(projectId, "clm_9999", { categories: [], durationS: 1 }),
    ).rejects.toThrow(AdjudicationPreconditionError);
    await expect(
      decideClaim(projectId, "clm_0001", {
        categories: [],
        durationS: Number.NaN,
      }),
    ).rejects.toThrow(AdjudicationPreconditionError);
  });
});
