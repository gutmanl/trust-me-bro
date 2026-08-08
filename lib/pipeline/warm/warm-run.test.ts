import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdapterProcessError,
  AdapterRateLimitError,
  createMockBackend,
  Orchestrator,
} from "../../adapters";
import type { RelevanceOutput } from "../../adapters";
import { RegisterStore } from "../../register";
import type { ClaimStatus } from "../../register";
import {
  ExtractionAlreadyRanError,
  ProjectAlreadyExistsError,
  RelevancePreconditionError,
  WarmRunPreconditionError,
} from "../errors";
import { importBriefing } from "../briefing";
import { addClaimWalkedTo } from "../__fixtures__/walk-claim";
import { createJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import { captureSource, freezeSourceSet } from "../sources/capture";
import { fakeFetcher } from "../sources/__fixtures__/fake-fetcher";
import { startExtraction } from "../extraction/run-extraction";
import { createWarmRunProject } from "./create-warm-run";
import { deriveRelevanceState } from "./derive-state";
import { pendingRelevancePopulation } from "./select-claims";
import { getRelevanceState, startRelevanceCheck } from "./run-relevance";

const ORIGIN = "proj_ursprung";
const WARM = "proj_folgefrage";
const SOURCE_TEXT = "Die Reviewzeit sank von 42 auf 19 Minuten.";

let workspace: string;
let runner: JobRunner;
let runCounter: number;
let nextClaim: number;
let sourceId: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-warm-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
  runCounter = 0;
  nextClaim = 0;
  runner = createJobRunner({ generateRunId: () => `lauf-${++runCounter}` });
  await RegisterStore.forProject(ORIGIN).create({
    id: ORIGIN,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    config: {
      rubric_version: "se-evidenz-rubrik-v1",
      adjudication_sample_rate: 0,
      backends: { primary: { cli: "claude", model_family: "anthropic" } },
    },
    actor: "human:lg",
  });
  const source = await captureSource(
    {
      projectId: ORIGIN,
      kind: "upload",
      sourceType: "begutachtete_publikation",
      manual: { title: "Studie", authors: "Meyer, Anna", year: "2025" },
      upload: { content: Buffer.from(SOURCE_TEXT), filename: "studie.txt" },
    },
    { fetcher: fakeFetcher({}) },
  );
  sourceId = source.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** Walks a fresh origin claim to the requested status via the shared
 * fixture. */
async function addOriginClaimAt(status: ClaimStatus): Promise<string> {
  nextClaim += 1;
  return addClaimWalkedTo({
    projectId: ORIGIN,
    claimNumber: nextClaim,
    sourceId,
    status,
  });
}

function relevanceOrchestrator(
  output?: RelevanceOutput,
  script?: ReadonlyArray<Error | "ok">,
): Orchestrator {
  const backend = createMockBackend({
    id: "claude",
    model: "claude-sonnet-5",
    overrides: output ? { relevance: output } : {},
    script,
  });
  return new Orchestrator({
    backends: [backend],
    traceSink: { write: async () => {} },
    gate: { run: (fn) => fn() },
    policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    sleep: async () => {},
  });
}

describe("createWarmRunProject", () => {
  it("rejects an unfrozen origin", async () => {
    await addOriginClaimAt("bestaetigt");
    await expect(
      createWarmRunProject({
        originProjectId: ORIGIN,
        newProjectId: WARM,
        newResearchQuestion: "Wie wirken LLM-Reviews auf die Codequalität?",
      }),
    ).rejects.toBeInstanceOf(WarmRunPreconditionError);
  });

  it("rejects an unchanged research question", async () => {
    await addOriginClaimAt("bestaetigt");
    await freezeSourceSet(ORIGIN);
    await expect(
      createWarmRunProject({
        originProjectId: ORIGIN,
        newProjectId: WARM,
        newResearchQuestion: "Reduzieren LLM-Reviews die Reviewzeit?",
      }),
    ).rejects.toBeInstanceOf(WarmRunPreconditionError);
  });

  it("rejects an origin without settled claims", async () => {
    await addOriginClaimAt("erfasst");
    await addOriginClaimAt("zur_adjudikation");
    await freezeSourceSet(ORIGIN);
    await expect(
      createWarmRunProject({
        originProjectId: ORIGIN,
        newProjectId: WARM,
        newResearchQuestion: "Wie wirken LLM-Reviews auf die Codequalität?",
      }),
    ).rejects.toBeInstanceOf(WarmRunPreconditionError);
  });

  it("adopts settled claims verbatim into a frozen follow-up project", async () => {
    const confirmed = await addOriginClaimAt("bestaetigt");
    const autoConfirmed = await addOriginClaimAt("automatisch_bestaetigt");
    const discarded = await addOriginClaimAt("verworfen");
    const open = await addOriginClaimAt("zur_adjudikation");
    await freezeSourceSet(ORIGIN);

    const result = await createWarmRunProject({
      originProjectId: ORIGIN,
      newProjectId: WARM,
      newResearchQuestion: "Wie wirken LLM-Reviews auf die Codequalität?",
    });
    expect(result.adoptedCount).toBe(3);
    expect(result.adoptedByStatus).toEqual({
      bestaetigt: 1,
      automatisch_bestaetigt: 1,
      verworfen: 1,
    });
    expect(result.copiedSourceCount).toBe(1);

    const store = RegisterStore.forProject(WARM);
    const register = await store.read();

    // Config inherited, corpus copied verbatim and frozen immediately.
    expect(register.config).toEqual(
      (await RegisterStore.forProject(ORIGIN).read()).config,
    );
    expect(register.sources).toHaveLength(1);
    expect(register.sources[0].id).toBe(sourceId);
    expect(
      register.project_events.some(
        (event) => event.event === "source_set_frozen",
      ),
    ).toBe(true);
    const snapshot = register.sources[0].custom.snapshot;
    expect(
      store
        .blobs()
        .read(snapshot?.blob_path as string)
        .toString(),
    ).toBe(SOURCE_TEXT);

    // Adopted claims: ids verbatim, single creation entry directly into the
    // settled origin status, origin referenced in provenance.
    const statusOf = (id: string) =>
      register.claims.find((claim) => claim.id === id)?.status;
    expect(statusOf(confirmed)).toBe("bestaetigt");
    expect(statusOf(autoConfirmed)).toBe("automatisch_bestaetigt");
    expect(statusOf(discarded)).toBe("verworfen");
    expect(register.claims.map((claim) => claim.id)).not.toContain(open);
    for (const claim of register.claims) {
      expect(claim.provenance.origin_project_id).toBe(ORIGIN);
      expect(claim.history).toHaveLength(1);
      expect(claim.history[0].from_status).toBeNull();
      expect(claim.history[0].reason).toContain(ORIGIN);
      expect(claim.evidence[0].existence_check?.status).toBe("bestanden");
    }

    expect((await store.verify()).ok).toBe(true);

    await expect(
      createWarmRunProject({
        originProjectId: ORIGIN,
        newProjectId: WARM,
        newResearchQuestion: "Noch eine andere Frage?",
      }),
    ).rejects.toBeInstanceOf(ProjectAlreadyExistsError);
  });

  it("allows the warm project's own one-shot extraction past the adopted claims", async () => {
    await addOriginClaimAt("bestaetigt");
    await freezeSourceSet(ORIGIN);
    await createWarmRunProject({
      originProjectId: ORIGIN,
      newProjectId: WARM,
      newResearchQuestion: "Wie wirken LLM-Reviews auf die Codequalität?",
    });
    await importBriefing({
      projectId: WARM,
      content: "Neues Briefing.",
      tool: "test",
    });

    const extractionBackend = createMockBackend({
      id: "claude",
      model: "claude-sonnet-5",
      overrides: {
        extraction: {
          claims: [
            {
              text: "Neuer Claim zur Codequalität.",
              claim_type: "wirksamkeitsaussage",
              briefing_anchor: "p1",
              evidence: [
                {
                  source_id: sourceId,
                  locator: { page: 1 },
                  verbatim_excerpt: "Reviewzeit sank",
                },
              ],
            },
          ],
        },
      },
    });
    const orchestrator = new Orchestrator({
      backends: [extractionBackend],
      traceSink: { write: async () => {} },
      gate: { run: (fn) => fn() },
      policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
      sleep: async () => {},
    });
    const handle = await startExtraction(WARM, { orchestrator, runner });
    await handle.done;

    const register = await RegisterStore.forProject(WARM).read();
    // Fresh id minted past the highest adopted id (clm_0001 adopted).
    expect(register.claims.map((claim) => claim.id)).toContain("clm_0002");
    // A second extraction is now blocked by the native claim.
    await expect(
      startExtraction(WARM, { orchestrator, runner }),
    ).rejects.toBeInstanceOf(ExtractionAlreadyRanError);
  });
});

describe("relevance check", () => {
  async function setupWarmProject(): Promise<{
    confirmed: string;
    autoConfirmed: string;
    discarded: string;
  }> {
    const confirmed = await addOriginClaimAt("bestaetigt");
    const autoConfirmed = await addOriginClaimAt("automatisch_bestaetigt");
    const discarded = await addOriginClaimAt("verworfen");
    await freezeSourceSet(ORIGIN);
    await createWarmRunProject({
      originProjectId: ORIGIN,
      newProjectId: WARM,
      newResearchQuestion: "Wie wirken LLM-Reviews auf die Codequalität?",
    });
    return { confirmed, autoConfirmed, discarded };
  }

  it("selects only settled positive adopted claims", async () => {
    const { confirmed, autoConfirmed } = await setupWarmProject();
    const register = await RegisterStore.forProject(WARM).read();
    expect(
      pendingRelevancePopulation(
        register.claims,
        register.project_events,
      ).sort(),
    ).toEqual([confirmed, autoConfirmed].sort());
    expect(deriveRelevanceState(register, false).status).toBe(
      "nicht_gestartet",
    );
  });

  it("keeps relevant claims untouched and closes the bracket", async () => {
    const { confirmed, autoConfirmed } = await setupWarmProject();
    const handle = await startRelevanceCheck(WARM, {
      orchestrator: relevanceOrchestrator({
        einschlaegig: "ja",
        reasoning: "Betrifft die Codequalität unmittelbar.",
      }),
      runner,
    });
    await handle.done;

    const store = RegisterStore.forProject(WARM);
    const register = await store.read();
    const statusOf = (id: string) =>
      register.claims.find((claim) => claim.id === id)?.status;
    expect(statusOf(confirmed)).toBe("bestaetigt");
    expect(statusOf(autoConfirmed)).toBe("automatisch_bestaetigt");
    const completedEvent = register.project_events.find(
      (event) => event.event === "relevance_run_completed",
    );
    expect(completedEvent?.reason).toContain("2 einschlägig");
    expect(
      pendingRelevancePopulation(register.claims, register.project_events),
    ).toEqual([]);
    expect(getRelevanceState(WARM, register, { runner }).status).toBe(
      "abgeschlossen",
    );
    expect((await store.verify()).ok).toBe(true);

    await expect(
      startRelevanceCheck(WARM, {
        orchestrator: relevanceOrchestrator(),
        runner,
      }),
    ).rejects.toBeInstanceOf(RelevancePreconditionError);
  });

  it("refuses to start when the primary backend fails preflight (TMB-49)", async () => {
    await setupWarmProject();
    await expect(
      startRelevanceCheck(WARM, {
        orchestrator: relevanceOrchestrator(),
        runner,
        preflight: async () => ({
          usable: false,
          hint: "claude nicht gefunden – installieren.",
        }),
      }),
    ).rejects.toThrow(/nicht einsatzbereit.*claude nicht gefunden/);
  });

  it("routes negative and uncertain judgments to adjudication", async () => {
    const { confirmed, autoConfirmed } = await setupWarmProject();
    const handle = await startRelevanceCheck(WARM, {
      orchestrator: relevanceOrchestrator({
        einschlaegig: "nein",
        reasoning: "Betrifft nur die Reviewzeit, nicht die Codequalität.",
      }),
      runner,
    });
    await handle.done;

    const register = await RegisterStore.forProject(WARM).read();
    for (const id of [confirmed, autoConfirmed]) {
      const claim = register.claims.find((candidate) => candidate.id === id);
      expect(claim?.status).toBe("zur_adjudikation");
      const entry = claim?.history.at(-1);
      expect(entry?.routing).toBe("einschlaegigkeit_negativ");
      expect(entry?.reason).toContain("negativ");
    }
    expect(
      register.project_events.find(
        (event) => event.event === "relevance_run_completed",
      )?.reason,
    ).toContain("2 zur Adjudikation");
  });

  it("escalates exhausted adapter calls and still closes the bracket", async () => {
    await setupWarmProject();
    const failure = new AdapterProcessError("claude", "relevance", 1, "kaputt");
    const handle = await startRelevanceCheck(WARM, {
      orchestrator: relevanceOrchestrator(undefined, [
        failure,
        failure,
        failure,
        failure,
      ]),
      runner,
    });
    await handle.done;

    const register = await RegisterStore.forProject(WARM).read();
    const routed = register.claims.filter(
      (claim) => claim.status === "zur_adjudikation",
    );
    expect(routed).toHaveLength(2);
    for (const claim of routed) {
      expect(claim.history.at(-1)?.routing).toBe("eskaliert");
    }
    expect(
      register.project_events.some(
        (event) => event.event === "relevance_run_completed",
      ),
    ).toBe(true);
  });

  it("pauses on rate limits, leaves the bracket open and resumes", async () => {
    const { confirmed, autoConfirmed } = await setupWarmProject();
    const handle = await startRelevanceCheck(WARM, {
      orchestrator: relevanceOrchestrator(
        { einschlaegig: "ja", reasoning: "Passt." },
        [new AdapterRateLimitError("claude", "relevance", "limit erreicht")],
      ),
      runner,
    });
    await handle.done;

    let register = await RegisterStore.forProject(WARM).read();
    expect(getRelevanceState(WARM, register, { runner }).status).toBe(
      "unterbrochen",
    );
    expect(
      register.project_events.some(
        (event) => event.event === "relevance_run_completed",
      ),
    ).toBe(false);

    // The resumed run sweeps the full remainder and closes the bracket.
    const resumed = await startRelevanceCheck(WARM, {
      orchestrator: relevanceOrchestrator({
        einschlaegig: "ja",
        reasoning: "Passt.",
      }),
      runner,
    });
    await resumed.done;
    register = await RegisterStore.forProject(WARM).read();
    expect(getRelevanceState(WARM, register, { runner }).status).toBe(
      "abgeschlossen",
    );
    const statusOf = (id: string) =>
      register.claims.find((claim) => claim.id === id)?.status;
    expect(statusOf(confirmed)).toBe("bestaetigt");
    expect(statusOf(autoConfirmed)).toBe("automatisch_bestaetigt");
  });
});
