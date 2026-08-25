import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdapterRateLimitError,
  createMockBackend,
  Orchestrator,
} from "../../adapters";
import type { JobRequest, RepairOutput } from "../../adapters";
import { RegisterStore } from "../../register";
import type { Claim, ClaimsRegister, Evidence } from "../../register";
import { createProject } from "../projects";
import { scrutinizeSuggestion } from "./scrutiny";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-scrutiny-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

const PROJECT_ID = "proj_gegenpruefung";

/** One machine-parked claim whose single evidence carries an OLD judgment
 * contradicting the wording — proving the counter-check judges the proposal
 * fresh instead of folding stale judgments into the relation. */
async function projectWithClaim(): Promise<RegisterStore> {
  await createProject({
    id: PROJECT_ID,
    research_question: "Frage?",
    primaryCli: "claude",
  });
  const store = RegisterStore.forProject(PROJECT_ID);
  await store.transaction((tx) => {
    tx.addSource({
      id: "src_0001",
      type: "article-journal",
      title: "Testquelle",
      custom: { source_type: "peer_reviewed_publication" },
    } as never);
    tx.addClaim({
      claim: {
        id: "clm_0001",
        text: "Reviews reduzieren die Fehlerdichte immer deutlich.",
        claim_type: "effectiveness_statement",
        briefing_anchor: "p1",
        provenance: {
          tool: "claude",
          model: "claude-sonnet-5",
          extracted_at: "2026-08-08T09:00:00Z",
          search_path: "briefing",
        },
        evidence: [
          {
            id: "ev_0001",
            source_id: "src_0001",
            locator: { page: 3 },
            verbatim_excerpt: "Reviews reduzieren die Fehlerdichte um 12 %.",
            existence_check: { status: "passed", at: "2026-08-08T09:00:00Z" },
            judgments: [
              {
                backend: "claude",
                model: "claude-sonnet-5",
                relation_type: "contradicts",
                confidence: 0.9,
                reasoning: "Altes Urteil zur ALTEN Formulierung.",
                at: "2026-08-08T09:00:00Z",
              },
            ],
          } as Evidence,
        ],
      } as Omit<Claim, "status" | "history">,
      actor: "system:extraction",
      reason: "Extrahiert.",
    });
  });
  return store;
}

const PROPOSAL: RepairOutput = {
  suggested_text: "Reviews können die Fehlerdichte messbar senken.",
  reasoning: "Abschwächung auf den Einzelbefund.",
};

function orchestratorWith(options: {
  rubric?: { calibration_result: string; reasoning: string };
  script?: Error[];
}): { orchestrator: Orchestrator; calls: readonly JobRequest[] } {
  const backend = createMockBackend({
    id: "claude",
    model: "claude-sonnet-5",
    overrides: options.rubric ? { rubric: options.rubric as never } : {},
    script: options.script ?? [],
  });
  return {
    orchestrator: new Orchestrator({
      backends: [backend],
      traceSink: { write: async () => {} },
      gate: { run: (fn) => fn() },
      policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
      sleep: async () => {},
    }),
    calls: backend.calls,
  };
}

async function context(): Promise<{
  register: ClaimsRegister;
  projectDir: string;
  claim: Claim;
}> {
  const store = RegisterStore.forProject(PROJECT_ID);
  const register = await store.read();
  return {
    register,
    projectDir: store.projectDir,
    claim: register.claims[0],
  };
}

describe("scrutinizeSuggestion", () => {
  it("judges the PROPOSED wording fresh — stale judgments do not count", async () => {
    await projectWithClaim();
    const { register, projectDir, claim } = await context();
    const { orchestrator, calls } = orchestratorWith({});
    const outcome = await scrutinizeSuggestion(
      register,
      projectDir,
      orchestrator,
      claim,
      PROPOSAL,
    );
    // The old "contradicts" judgment would leave the relation divergent if
    // it were folded in; a fresh single-backend pass resolves to supports.
    expect(outcome).toMatchObject({
      status: "ok",
      verdict: { calibrationResult: "licensed", supportDegree: "supported" },
    });
    const attribution = calls.find((job) => job.kind === "attribution");
    expect((attribution?.input as { claim: { text: string } }).claim.text).toBe(
      PROPOSAL.suggested_text,
    );
    // Nothing was persisted: the counter-check is a forecast.
    const after = await RegisterStore.forProject(PROJECT_ID).read();
    expect(after.claims[0].text).toBe(claim.text);
    expect(after.claims[0].evidence[0].judgments).toHaveLength(1);
  });

  it("judges against corrected excerpts when the proposal repairs quotes", async () => {
    await projectWithClaim();
    const { register, projectDir, claim } = await context();
    const { orchestrator, calls } = orchestratorWith({});
    await scrutinizeSuggestion(register, projectDir, orchestrator, claim, {
      ...PROPOSAL,
      evidence_repairs: [
        {
          evidence_id: "ev_0001",
          corrected_excerpt: "Reviews senkten die Fehlerdichte um 12,4 %.",
        },
      ],
    });
    const attribution = calls.find((job) => job.kind === "attribution");
    expect(
      (attribution?.input as { evidence: { verbatim_excerpt: string } })
        .evidence.verbatim_excerpt,
    ).toBe("Reviews senkten die Fehlerdichte um 12,4 %.");
  });

  it("degrades to 'unavailable' on a rate-limited backend", async () => {
    await projectWithClaim();
    const { register, projectDir, claim } = await context();
    const { orchestrator } = orchestratorWith({
      script: [
        new AdapterRateLimitError("claude", "attribution", "rate limited"),
      ],
    });
    const outcome = await scrutinizeSuggestion(
      register,
      projectDir,
      orchestrator,
      claim,
      PROPOSAL,
    );
    expect(outcome.status).toBe("unavailable");
  });

  it("degrades to 'unavailable' on an unresolvable rubric pin", async () => {
    await projectWithClaim();
    const { register, projectDir, claim } = await context();
    const broken: ClaimsRegister = {
      ...register,
      config: { ...register.config, rubric_version: "no-such-rubric" },
    };
    const { orchestrator } = orchestratorWith({});
    const outcome = await scrutinizeSuggestion(
      broken,
      projectDir,
      orchestrator,
      claim,
      PROPOSAL,
    );
    expect(outcome.status).toBe("unavailable");
  });
});
