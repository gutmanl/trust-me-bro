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
import type {
  AttributionOutput,
  ExtractionOutput,
  RubricOutput,
} from "../../adapters";
import { RegisterStore } from "../../register";
import type { ClaimsRegister, ProjectConfig } from "../../register";
import { importBriefing } from "../briefing";
import { VerificationPreconditionError } from "../errors";
import { createJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import { captureSource, freezeSourceSet } from "../sources/capture";
import { fakeFetcher } from "../sources/__fixtures__/fake-fetcher";
import { startExtraction } from "../extraction/run-extraction";
import { getVerificationState, startVerification } from "./run-verification";

const PROJECT = "proj_pruefung";
const SOURCE_TEXT =
  "median review time dropped from 42 to 19 minutes. " +
  "developer satisfaction increased.";

const IN_TEXT_EXCERPT = "median review time dropped from 42 to 19 minutes";

function extractionOutput(
  claims: Array<{ excerpt?: string }>,
): ExtractionOutput {
  return {
    claims: claims.map((claim, index) => ({
      text: `Behauptung Nummer ${index + 1}.`,
      claim_type: "quantitativer_einzelbefund",
      briefing_anchor: `p${index + 1}`,
      evidence:
        claim.excerpt === undefined
          ? []
          : [
              {
                source_id: "src_studie",
                locator: { page: 1 },
                verbatim_excerpt: claim.excerpt,
              },
            ],
    })),
  };
}

interface MockOutputs {
  primaryAttribution?: AttributionOutput;
  secondaryAttribution?: AttributionOutput;
  rubric?: RubricOutput;
  primaryScript?: ReadonlyArray<Error | "ok">;
}

function makeOrchestrator(
  outputs: MockOutputs = {},
  extraction?: ExtractionOutput,
): Orchestrator {
  const primary = createMockBackend({
    id: "claude",
    model: "claude-sonnet-5",
    overrides: {
      ...(extraction ? { extraction } : {}),
      ...(outputs.primaryAttribution
        ? { attribution: outputs.primaryAttribution }
        : {}),
      ...(outputs.rubric ? { rubric: outputs.rubric } : {}),
    },
    script: outputs.primaryScript,
  });
  const secondary = createMockBackend({
    id: "codex",
    model: "gpt-x",
    overrides: outputs.secondaryAttribution
      ? { attribution: outputs.secondaryAttribution }
      : {},
  });
  return new Orchestrator({
    backends: [primary, secondary],
    traceSink: { write: async () => {} },
    gate: { run: (fn) => fn() },
    policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    sleep: async () => {},
  });
}

let workspace: string;
let runner: JobRunner;
let runCounter: number;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-verification-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
  runCounter = 0;
  runner = createJobRunner({ generateRunId: () => `lauf-${++runCounter}` });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function createTestProject(
  configOverrides: Partial<ProjectConfig> = {},
): Promise<void> {
  await RegisterStore.forProject(PROJECT).create({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    config: {
      rubric_version: "se-evidenz-rubrik-v1",
      adjudication_sample_rate: 0,
      backends: {
        primary: { cli: "claude", model_family: "anthropic" },
        secondary: { cli: "codex", model_family: "openai" },
      },
      second_opinion: {
        confidence_threshold: 0.8,
        on_relation_not_stuetzt: true,
      },
      ...configOverrides,
    },
    actor: "human:lg",
  });
}

async function extractClaims(output: ExtractionOutput): Promise<void> {
  await importBriefing({ projectId: PROJECT, content: "Briefing.", tool: "x" });
  await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "begutachtete_publikation",
      manual: { title: "Studie", authors: "Studie, A." },
      upload: { content: Buffer.from(SOURCE_TEXT), filename: "studie.txt" },
    },
    { fetcher: fakeFetcher({}) },
  );
  await freezeSourceSet(PROJECT);
  const handle = await startExtraction(PROJECT, {
    orchestrator: makeOrchestrator({}, output),
    runner,
  });
  await handle.done;
}

async function runVerification(outputs: MockOutputs = {}) {
  const handle = await startVerification(PROJECT, {
    orchestrator: makeOrchestrator(outputs),
    runner,
    fetcher: fakeFetcher({}),
  });
  await handle.done;
  return handle;
}

async function readRegister(): Promise<ClaimsRegister> {
  return RegisterStore.forProject(PROJECT).read();
}

describe("startVerification preconditions", () => {
  it("requires extracted claims and open work", async () => {
    await createTestProject();
    await expect(startVerification(PROJECT)).rejects.toBeInstanceOf(
      VerificationPreconditionError,
    );
  });

  it("rejects an unknown rubric version as unprüfbar", async () => {
    await createTestProject({ rubric_version: "se-evidenz-rubrik-v99" });
    await extractClaims(extractionOutput([{ excerpt: IN_TEXT_EXCERPT }]));
    await expect(startVerification(PROJECT)).rejects.toThrow(/nicht prüfbar/);
  });
});

describe("cascading verification run", () => {
  it("carries a claim through all stages to automatic confirmation", async () => {
    await createTestProject();
    await extractClaims(extractionOutput([{ excerpt: IN_TEXT_EXCERPT }, {}]));
    const handle = await runVerification();

    const register = await readRegister();
    const [confirmed, unbelegt] = register.claims;
    expect(confirmed.status).toBe("automatisch_bestaetigt");
    expect(confirmed.evidence[0].existence_check?.status).toBe("bestanden");
    expect(confirmed.evidence[0].judgments).toHaveLength(1);
    expect(confirmed.evidence[0].relation_type).toBe("stuetzt");
    expect(confirmed.support_degree).toBe("supported");
    expect(confirmed.calibration_result).toBe("lizenziert");
    // Status trail: erfasst → existenzgeprueft → vorgeprueft → automatisch.
    expect(confirmed.history.map((entry) => entry.to_status)).toEqual([
      "erfasst",
      "existenzgeprueft",
      "vorgeprueft",
      "automatisch_bestaetigt",
    ]);
    // The unbelegter claim was never touched by the run.
    expect(unbelegt.status).toBe("zur_adjudikation");
    expect(unbelegt.evidence).toHaveLength(0);

    const events = register.project_events
      .filter((event) => event.event.startsWith("verification_run"))
      .map((event) => event.event);
    expect(events).toEqual([
      "verification_run_started",
      "verification_run_completed",
    ]);
    expect((await RegisterStore.forProject(PROJECT).verify()).ok).toBe(true);
    expect(getVerificationState(PROJECT, register, { runner }).status).toBe(
      "abgeschlossen",
    );

    const itemOutcomes = handle
      .eventsSoFar()
      .filter((event) => event.type === "item_completed")
      .map((event) =>
        event.type === "item_completed" ? event.outcome.result : undefined,
      );
    expect(itemOutcomes[0]).toMatchObject({
      outcome: "automatisch_bestaetigt",
    });
    expect(itemOutcomes[1]).toMatchObject({ outcome: "stichprobe" });
  });

  it("routes claims with failed existence checks to adjudication", async () => {
    await createTestProject();
    await extractClaims(
      extractionOutput([{ excerpt: "dieser Wortlaut steht nirgends" }]),
    );
    await runVerification();

    const register = await readRegister();
    const claim = register.claims[0];
    expect(claim.status).toBe("zur_adjudikation");
    expect(claim.evidence[0].existence_check?.status).toBe("nicht_bestanden");
    expect(claim.evidence[0].judgments).toHaveLength(0); // stages 2/3 skipped
    expect(claim.history.at(-1)?.reason).toContain(
      "Existenzprüfung nicht bestanden",
    );
  });

  it("routes divergent backend judgments to adjudication with both visible", async () => {
    await createTestProject();
    await extractClaims(extractionOutput([{ excerpt: IN_TEXT_EXCERPT }]));
    await runVerification({
      primaryAttribution: {
        relation_type: "stuetzt_teilweise",
        confidence: 0.9,
        reasoning: "teils",
      },
      secondaryAttribution: {
        relation_type: "stuetzt",
        confidence: 0.9,
        reasoning: "voll",
      },
    });

    const claim = (await readRegister()).claims[0];
    expect(claim.status).toBe("zur_adjudikation");
    expect(claim.evidence[0].judgments.map((j) => j.backend)).toEqual([
      "claude",
      "codex",
    ]);
    expect(claim.evidence[0].relation_type).toBeUndefined();
    expect(claim.support_degree).toBeUndefined();
    expect(claim.history.at(-1)?.reason).toContain("Divergenz");
  });

  it("escalates exhausted adapter retries via the ratified edge", async () => {
    await createTestProject();
    await extractClaims(extractionOutput([{ excerpt: IN_TEXT_EXCERPT }]));
    const crash = new AdapterProcessError("claude", "attribution", 1, "boom");
    await runVerification({ primaryScript: [crash, crash] });

    const claim = (await readRegister()).claims[0];
    expect(claim.status).toBe("zur_adjudikation");
    expect(claim.history.map((entry) => entry.to_status)).toEqual([
      "erfasst",
      "existenzgeprueft",
      "zur_adjudikation",
    ]);
    expect(claim.history.at(-1)?.reason).toContain("eskaliert");
  });

  it("pauses on a rate limit: in-flight claim unchanged, rest skipped, resumable", async () => {
    await createTestProject();
    await extractClaims(
      extractionOutput([
        { excerpt: IN_TEXT_EXCERPT },
        { excerpt: "developer satisfaction increased" },
      ]),
    );
    const handle = await runVerification({
      primaryScript: [
        new AdapterRateLimitError("claude", "attribution", "429"),
      ],
    });

    const register = await readRegister();
    // Claim 1 passed stage 1 (persisted), then paused in stage 2: no
    // judgments, no further transition. Claim 2 untouched entirely.
    expect(register.claims[0].status).toBe("existenzgeprueft");
    expect(register.claims[0].evidence[0].judgments).toHaveLength(0);
    expect(register.claims[1].status).toBe("erfasst");
    const completed = register.project_events.at(-1);
    expect(completed?.event).toBe("verification_run_completed");
    expect(completed?.reason).toContain("pausiert");
    expect(getVerificationState(PROJECT, register, { runner }).status).toBe(
      "angehalten",
    );

    const outcomes = handle
      .eventsSoFar()
      .filter((event) => event.type === "item_completed")
      .map((event) =>
        event.type === "item_completed"
          ? (event.outcome.result as { outcome: string }).outcome
          : "",
      );
    expect(outcomes).toEqual(["pausiert", "uebersprungen", "stichprobe"]);

    // Resume: a fresh run picks up both claims and finishes them.
    await runVerification();
    const resumed = await readRegister();
    expect(resumed.claims.map((claim) => claim.status)).toEqual([
      "automatisch_bestaetigt",
      "automatisch_bestaetigt",
    ]);
    expect((await RegisterStore.forProject(PROJECT).verify()).ok).toBe(true);
  });

  it("locks the LLM stages when the primary fails preflight, stage 1 still runs (TMB-49)", async () => {
    await createTestProject();
    await extractClaims(extractionOutput([{ excerpt: IN_TEXT_EXCERPT }]));
    const handle = await startVerification(PROJECT, {
      orchestrator: makeOrchestrator(),
      runner,
      fetcher: fakeFetcher({}),
      preflight: async (cli) =>
        cli === "claude"
          ? { usable: false, hint: "claude nicht gefunden – installieren." }
          : { usable: true },
    });
    await handle.done;

    const register = await readRegister();
    const claim = register.claims[0];
    // Stage 1 ran and persisted; the LLM stages were skipped, the claim
    // rests at existenzgeprueft (NOT escalated to adjudication).
    expect(claim.status).toBe("existenzgeprueft");
    expect(claim.evidence[0].existence_check?.status).toBe("bestanden");
    expect(claim.evidence[0].judgments).toHaveLength(0);
    const started = register.project_events.find(
      (event) => event.event === "verification_run_started",
    );
    expect(started?.reason).toContain("LLM-Prüfstufen gesperrt");
    expect(started?.reason).toContain("claude nicht gefunden");

    const outcomes = handle
      .eventsSoFar()
      .filter((event) => event.type === "item_completed")
      .map((event) =>
        event.type === "item_completed"
          ? (event.outcome.result as { outcome: string }).outcome
          : "",
      );
    expect(outcomes).toEqual(["llm_gesperrt", "stichprobe"]);

    // With the backend back, a fresh run sweeps the claim up.
    await runVerification();
    expect((await readRegister()).claims[0].status).toBe(
      "automatisch_bestaetigt",
    );
  });

  it("disables the divergence rule when the secondary fails preflight (TMB-49)", async () => {
    await createTestProject();
    await extractClaims(extractionOutput([{ excerpt: IN_TEXT_EXCERPT }]));
    // Low confidence would normally trigger the second opinion.
    const handle = await startVerification(PROJECT, {
      orchestrator: makeOrchestrator({
        primaryAttribution: {
          relation_type: "stuetzt",
          confidence: 0.5,
          reasoning: "unsicher",
        },
      }),
      runner,
      fetcher: fakeFetcher({}),
      preflight: async (cli) =>
        cli === "codex"
          ? { usable: false, hint: "codex nicht gefunden." }
          : { usable: true },
    });
    await handle.done;

    const register = await readRegister();
    const claim = register.claims[0];
    // Only the primary judged: no second opinion despite the trigger.
    expect(claim.evidence[0].judgments.map((j) => j.backend)).toEqual([
      "claude",
    ]);
    const started = register.project_events.find(
      (event) => event.event === "verification_run_started",
    );
    expect(started?.reason).toContain("Divergenzregel deaktiviert");
    expect(started?.reason).toContain("codex");
    // The stored config keeps its secondary (per-run degradation only).
    expect(register.config.backends.secondary?.cli).toBe("codex");
  });

  it("draws the full sample at rate 1, marked as Stichprobenkontrolle", async () => {
    await createTestProject({ adjudication_sample_rate: 1 });
    await extractClaims(extractionOutput([{ excerpt: IN_TEXT_EXCERPT }]));
    await runVerification();

    const claim = (await readRegister()).claims[0];
    expect(claim.status).toBe("zur_adjudikation");
    const last = claim.history.at(-1);
    expect(last?.from_status).toBe("automatisch_bestaetigt");
    expect(last?.actor).toBe("system:stichprobe");
    expect(last?.reason).toContain("Stichprobenkontrolle");
    expect(last?.reason).toContain("Seed lauf-2");

    const completed = (await readRegister()).project_events.at(-1);
    expect(completed?.reason).toContain("1 Stichprobe(n)");
  });

  it("recovers a stranded sample draw after a crash before the draw item", async () => {
    await createTestProject({ adjudication_sample_rate: 1 });
    await extractClaims(extractionOutput([{ excerpt: IN_TEXT_EXCERPT }]));
    // Simulate a run that died right before its sample-draw item: the claim
    // is fully confirmed and committed, the bracket never closed.
    const store = RegisterStore.forProject(PROJECT);
    await store.transaction((tx) => {
      tx.recordProjectEvent({
        event: "verification_run_started",
        reason: "Prüflauf gestartet (Lauf tot-1).",
        actor: "system:verification",
      });
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "bestanden",
        at: "2026-08-07T10:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existenzgeprueft",
        actor: "system:existenzpruefung",
        reason: "Test.",
      });
      tx.appendJudgment("clm_0001", "ev_0001", {
        backend: "claude",
        model: "m",
        relation_type: "stuetzt",
        confidence: 0.9,
        reasoning: "ok",
        at: "2026-08-07T10:00:01Z",
      });
      tx.setResolvedRelation("clm_0001", "ev_0001", "stuetzt");
      tx.setSupportDegree("clm_0001", "supported");
      tx.setCalibrationResult("clm_0001", "lizenziert");
      tx.transitionClaim("clm_0001", {
        to: "vorgeprueft",
        actor: "system:vorpruefung",
        reason: "Test.",
      });
      tx.transitionClaim("clm_0001", {
        to: "automatisch_bestaetigt",
        actor: "system:vorpruefung",
        reason: "Test.",
      });
    });
    expect(
      getVerificationState(PROJECT, await readRegister(), { runner }).status,
    ).toBe("unterbrochen");

    // The recovery run consists of the sample-draw item alone: it sweeps up
    // the stranded confirmation and closes the bracket.
    await runVerification();
    const recovered = await readRegister();
    const claim = recovered.claims[0];
    expect(claim.status).toBe("zur_adjudikation");
    expect(claim.history.at(-1)?.reason).toContain("Stichprobenkontrolle");
    expect(recovered.project_events.at(-1)?.event).toBe(
      "verification_run_completed",
    );
    expect(getVerificationState(PROJECT, recovered, { runner }).status).toBe(
      "abgeschlossen",
    );
    expect((await store.verify()).ok).toBe(true);
  });

  it("blocks concurrent runs on the same project", async () => {
    await createTestProject();
    await extractClaims(extractionOutput([{ excerpt: IN_TEXT_EXCERPT }]));
    const first = await startVerification(PROJECT, {
      orchestrator: makeOrchestrator(),
      runner,
      fetcher: fakeFetcher({}),
    });
    await expect(
      startVerification(PROJECT, {
        orchestrator: makeOrchestrator(),
        runner,
        fetcher: fakeFetcher({}),
      }),
    ).rejects.toThrow(/bereits ein Lauf/);
    await first.done;
  });
});
