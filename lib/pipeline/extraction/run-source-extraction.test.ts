import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdapterProcessError,
  createMockBackend,
  Orchestrator,
} from "../../adapters";
import type { ExtractionInput, ExtractionOutput } from "../../adapters";
import { RegisterStore } from "../../register";
import { importBriefing } from "../briefing";
import { ExtractionPreconditionError, UnknownSourceError } from "../errors";
import { createProject } from "../projects";
import { createJobRunner } from "../runs/job-runner";
import { captureSource } from "../sources/capture";
import { fakeFetcher } from "../sources/__fixtures__/fake-fetcher";
import { deriveExtractionActivity } from "./derive-state";
import {
  startSourceExtraction,
  startUnevidencedExtraction,
} from "./run-source-extraction";

const PROJECT = "proj_extraktion";

const BRIEFING = [
  "# Briefing zur Reviewzeit",
  "LLM-Reviews reduzieren die mediane Reviewzeit um 55 % (Studie 2025).",
  "Langfristig steigt angeblich auch die Codequalität.",
].join("\n\n");

const SOURCE_OUTPUT: ExtractionOutput = {
  claims: [
    {
      text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
      claim_type: "quantitative_finding",
      anchor_quote: "reduzieren die mediane Reviewzeit um 55 %",
      evidence: [
        {
          source_id: "src_studie",
          locator: { page: 6 },
          verbatim_excerpt: "median review time dropped from 42 to 19 minutes",
        },
      ],
    },
  ],
  additional_evidence: [],
};

const SWEEP_OUTPUT: ExtractionOutput = {
  claims: [
    {
      text: "Langfristig steigt die Codequalität.",
      claim_type: "effectiveness_statement",
      anchor_quote: "Langfristig steigt angeblich",
      evidence: [],
    },
  ],
  additional_evidence: [],
};

function testOrchestrator(options?: {
  output?: ExtractionOutput;
  script?: ReadonlyArray<Error | "ok">;
}): Orchestrator & { extractionInputs: () => ExtractionInput[] } {
  const backend = createMockBackend({
    id: "claude",
    model: "claude-sonnet-5",
    overrides: { extraction: options?.output ?? SOURCE_OUTPUT },
    script: options?.script,
  });
  const orchestrator = new Orchestrator({
    backends: [backend],
    traceSink: { write: async () => {} },
    gate: { run: (fn) => fn() },
    policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    sleep: async () => {},
  });
  return Object.assign(orchestrator, {
    extractionInputs: (): ExtractionInput[] =>
      backend.calls
        .filter((job) => job.kind === "extraction")
        .map((job) => job.input as ExtractionInput),
  });
}

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-source-extraction-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
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

async function prepareProject(): Promise<void> {
  await importBriefing({
    projectId: PROJECT,
    content: BRIEFING,
    tool: "deep-research-x",
  });
  const source = await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "peer_reviewed_publication",
      manual: { title: "Studie", authors: "Studie, A." },
      upload: {
        content: Buffer.from(
          "median review time dropped from 42 to 19 minutes",
        ),
        filename: "studie.txt",
      },
    },
    { fetcher: fakeFetcher({}) },
  );
  expect(source.id).toBe("src_studie");
}

describe("startSourceExtraction preconditions", () => {
  it("requires an imported briefing", async () => {
    await expect(
      startSourceExtraction(PROJECT, "src_studie"),
    ).rejects.toBeInstanceOf(ExtractionPreconditionError);
  });

  it("requires the source to exist", async () => {
    await prepareProject();
    await expect(
      startSourceExtraction(PROJECT, "src_unbekannt", {
        orchestrator: testOrchestrator(),
      }),
    ).rejects.toBeInstanceOf(UnknownSourceError);
  });

  it("refuses to start when the primary backend fails preflight (TMB-49)", async () => {
    await prepareProject();
    await expect(
      startSourceExtraction(PROJECT, "src_studie", {
        orchestrator: testOrchestrator(),
        preflight: async () => ({
          usable: false,
          hint: "claude nicht gefunden – installieren.",
        }),
      }),
    ).rejects.toThrow(/nicht einsatzbereit.*claude nicht gefunden/);
  });
});

describe("per-source extraction pass", () => {
  it("scopes the job to the source, commits the claims and brackets the run", async () => {
    await prepareProject();
    const orchestrator = testOrchestrator();
    const runner = createJobRunner({ generateRunId: () => "lauf-1" });
    const handle = await startSourceExtraction(PROJECT, "src_studie", {
      orchestrator,
      runner,
    });
    expect(await handle.done).toEqual({ succeeded: 1, failed: 0 });

    const [input] = orchestrator.extractionInputs();
    expect(input.target_source).toEqual({
      id: "src_studie",
      citation: expect.any(String),
    });
    expect(input.sources.map((source) => source.id)).toEqual(["src_studie"]);
    expect(input.known_claims).toEqual([]);
    expect(input.briefing_text).toBe(BRIEFING);

    const store = RegisterStore.forProject(PROJECT);
    const register = await store.read();
    expect(register.claims.map((claim) => [claim.id, claim.status])).toEqual([
      ["clm_0001", "captured"],
    ]);
    expect(register.claims[0].briefing_anchor).toBe("p2");
    const batchEvents = register.project_events.filter((event) =>
      event.event.startsWith("batch_run"),
    );
    expect(batchEvents.map((event) => event.event)).toEqual([
      "batch_run_started",
      "batch_run_completed",
    ]);
    expect(batchEvents[0].reason).toContain("src_studie");
    // Source work items: both brackets carry the structured attribution.
    expect(batchEvents[0].source_id).toBe("src_studie");
    expect(batchEvents[1].source_id).toBe("src_studie");
    expect((await store.verify()).ok).toBe(true);
    expect(deriveExtractionActivity(register, false).lastOutcome).toBe(
      "completed",
    );
    // The projection is re-rendered after the commit.
    expect(
      fs.readFileSync(path.join(store.projectDir, "briefing.md"), "utf8"),
    ).toContain("clm_0001");
  });

  it("is repeatable: a second pass over the same source dedupes instead of duplicating", async () => {
    await prepareProject();
    const first = await startSourceExtraction(PROJECT, "src_studie", {
      orchestrator: testOrchestrator(),
      runner: createJobRunner(),
    });
    await first.done;
    const orchestrator = testOrchestrator();
    const second = await startSourceExtraction(PROJECT, "src_studie", {
      orchestrator,
      runner: createJobRunner(),
    });
    const summary = await second.done;
    expect(summary).toEqual({ succeeded: 1, failed: 0 });

    // The second pass knows the claim the first one committed.
    expect(orchestrator.extractionInputs()[0].known_claims).toEqual([
      {
        id: "clm_0001",
        text: SOURCE_OUTPUT.claims[0].text,
        claim_type: "quantitative_finding",
      },
    ]);
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(register.claims).toHaveLength(1);
    expect(register.claims[0].evidence).toHaveLength(1);
  });

  it("records a failure completion with zero claims when attempts are exhausted", async () => {
    await prepareProject();
    const crash = new AdapterProcessError("claude", "extraction", 1, "boom");
    const handle = await startSourceExtraction(PROJECT, "src_studie", {
      orchestrator: testOrchestrator({ script: [crash, crash] }),
      runner: createJobRunner(),
    });
    await handle.done;
    const completed = handle
      .eventsSoFar()
      .find((event) => event.type === "item_completed");
    expect(completed).toMatchObject({
      outcome: { status: "ok", result: { outcome: "failed" } },
    });

    const register = await RegisterStore.forProject(PROJECT).read();
    expect(register.claims).toHaveLength(0);
    const failedEvent = register.project_events.at(-1);
    expect(failedEvent?.event).toBe("batch_run_completed");
    expect(failedEvent?.source_id).toBe("src_studie");
    expect(deriveExtractionActivity(register, false).lastOutcome).toBe(
      "failed",
    );
  });

  it("salvages a bundle with an unknown source: bad evidence dropped, claim escalated", async () => {
    // Extraction salvage: a hallucinated source_id no longer rejects the
    // whole pass — the bad evidence entry is filtered, the claim routes
    // through the ordinary no-evidence gate, and the drop is named.
    await prepareProject();
    const badOutput: ExtractionOutput = {
      claims: [
        {
          text: "Claim mit unbekannter Quelle.",
          claim_type: "quantitative_finding",
          anchor_quote: "reduzieren die mediane Reviewzeit",
          evidence: [
            {
              source_id: "src_unbekannt",
              locator: { page: 1 },
              verbatim_excerpt: "irgendein Auszug",
            },
          ],
        },
      ],
      additional_evidence: [],
    };
    const handle = await startSourceExtraction(PROJECT, "src_studie", {
      orchestrator: testOrchestrator({ output: badOutput }),
      runner: createJobRunner(),
    });
    await handle.done;

    const register = await RegisterStore.forProject(PROJECT).read();
    expect(register.claims).toHaveLength(1);
    const claim = register.claims[0];
    expect(claim.evidence).toHaveLength(0);
    expect(claim.status).toBe("pending_adjudication");
    expect(claim.history[0]?.reason).toContain("unbekannte Quellen-Ids");
    expect(register.project_events.at(-1)?.reason).toContain(
      "Beleg(e) mit unbekannter Quellen-Id verworfen (src_unbekannt)",
    );
    expect((await RegisterStore.forProject(PROJECT).verify()).ok).toBe(true);
  });
});

describe("unevidenced sweep pass", () => {
  it("runs without a target source and routes its claims to adjudication", async () => {
    await prepareProject();
    const orchestrator = testOrchestrator({ output: SWEEP_OUTPUT });
    const handle = await startUnevidencedExtraction(PROJECT, {
      orchestrator,
      runner: createJobRunner(),
    });
    await handle.done;

    expect(orchestrator.extractionInputs()[0].target_source).toBeNull();
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(register.claims.map((claim) => claim.status)).toEqual([
      "pending_adjudication",
    ]);
    expect(register.claims[0].evidence).toEqual([]);
    expect(register.project_events.at(-1)?.reason).toContain("Sweep");
  });

  it("needs no captured source at all", async () => {
    await importBriefing({
      projectId: PROJECT,
      content: BRIEFING,
      tool: "deep-research-x",
    });
    const orchestrator = testOrchestrator({ output: SWEEP_OUTPUT });
    const handle = await startUnevidencedExtraction(PROJECT, {
      orchestrator,
      runner: createJobRunner(),
    });
    await handle.done;
    expect(orchestrator.extractionInputs()[0].sources).toEqual([]);
    expect(
      (await RegisterStore.forProject(PROJECT).read()).claims,
    ).toHaveLength(1);
  });
});
