import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdapterProcessError,
  createMockBackend,
  Orchestrator,
} from "../../adapters";
import type { ExtractionOutput } from "../../adapters";
import { RegisterStore } from "../../register";
import { importBriefing } from "../briefing";
import {
  ExtractionAlreadyRanError,
  ExtractionPreconditionError,
} from "../errors";
import { createProject } from "../projects";
import { createJobRunner } from "../runs/job-runner";
import { captureSource, freezeSourceSet } from "../sources/capture";
import { fakeFetcher } from "../sources/__fixtures__/fake-fetcher";
import { getExtractionState, startExtraction } from "./run-extraction";

const BRIEFING = [
  "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
  "Langfristig steigt angeblich auch die Codequalität.",
].join("\n\n");

const EXTRACTION_OUTPUT: ExtractionOutput = {
  claims: [
    {
      text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
      claim_type: "quantitativer_einzelbefund",
      briefing_anchor: "p1",
      evidence: [
        {
          source_id: "src_studie",
          locator: { page: 6 },
          verbatim_excerpt: "median review time dropped from 42 to 19 minutes",
        },
      ],
    },
    {
      text: "Langfristig steigt die Codequalität.",
      claim_type: "wirksamkeitsaussage",
      briefing_anchor: "p2",
      evidence: [],
    },
    {
      text: "Die Reviewzeit sinkt deutlich. Zudem steigt die Zufriedenheit im Team.",
      claim_type: "wirksamkeitsaussage",
      briefing_anchor: "p2",
      evidence: [
        {
          source_id: "src_studie",
          locator: { section: "5" },
          verbatim_excerpt: "developer satisfaction increased",
        },
      ],
    },
  ],
};

function testOrchestrator(options?: {
  output?: ExtractionOutput;
  script?: ReadonlyArray<Error | "ok">;
}): Orchestrator {
  const backend = createMockBackend({
    id: "claude",
    model: "claude-sonnet-5",
    overrides: { extraction: options?.output ?? EXTRACTION_OUTPUT },
    script: options?.script,
  });
  return new Orchestrator({
    backends: [backend],
    traceSink: { write: async () => {} },
    gate: { run: (fn) => fn() },
    policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    sleep: async () => {},
  });
}

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-extraction-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
  await createProject({
    id: "proj_extraktion",
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  // maxRetries: Windows intermittently reports ENOTEMPTY while the just-
  // finished run's file handles are still closing (observed flaky cleanup).
  fs.rmSync(workspace, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

async function prepareProject(): Promise<void> {
  await importBriefing({
    projectId: "proj_extraktion",
    content: BRIEFING,
    tool: "deep-research-x",
  });
  const source = await captureSource(
    {
      projectId: "proj_extraktion",
      kind: "upload",
      sourceType: "begutachtete_publikation",
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
  // The mock output references src_studie — rename via re-capture is not
  // possible, so assert the minted id matches the fixture's expectation.
  expect(source.id).toBe("src_studie");
  await freezeSourceSet("proj_extraktion");
}

describe("startExtraction preconditions", () => {
  it("requires an imported briefing", async () => {
    await expect(startExtraction("proj_extraktion")).rejects.toBeInstanceOf(
      ExtractionPreconditionError,
    );
  });

  it("requires a frozen source set", async () => {
    await importBriefing({
      projectId: "proj_extraktion",
      content: BRIEFING,
      tool: "x",
    });
    await expect(startExtraction("proj_extraktion")).rejects.toBeInstanceOf(
      ExtractionPreconditionError,
    );
  });

  it("refuses to start when the primary backend fails preflight (TMB-49)", async () => {
    await prepareProject();
    await expect(
      startExtraction("proj_extraktion", {
        orchestrator: testOrchestrator(),
        preflight: async () => ({
          usable: false,
          hint: "claude nicht gefunden – installieren.",
        }),
      }),
    ).rejects.toThrow(/nicht einsatzbereit.*claude nicht gefunden/);
  });
});

describe("extraction run", () => {
  it("applies the bundle through both gates and brackets it with batch events", async () => {
    await prepareProject();
    const runner = createJobRunner({ generateRunId: () => "lauf-1" });
    const handle = await startExtraction("proj_extraktion", {
      orchestrator: testOrchestrator(),
      runner,
    });
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 1, failed: 0 });

    const store = RegisterStore.forProject("proj_extraktion");
    const register = await store.read();

    // Three claims: evidenced+atomic → erfasst; unbelegt → zur_adjudikation;
    // gebündelt → zur_adjudikation (Atomaritätsgate) despite evidence.
    expect(register.claims.map((claim) => [claim.id, claim.status])).toEqual([
      ["clm_0001", "erfasst"],
      ["clm_0002", "zur_adjudikation"],
      ["clm_0003", "zur_adjudikation"],
    ]);
    expect(register.claims[1].history[0].reason).toContain("Keine Fundstelle");
    expect(register.claims[2].history[0].reason).toContain("Atomaritätsgate");
    expect(register.claims[0].provenance).toMatchObject({
      tool: "claude",
      model: "claude-sonnet-5",
      search_path: "Extraktionslauf lauf-1",
    });
    expect(register.claims[0].evidence[0].id).toBe("ev_0001");

    const batchEvents = register.project_events.filter((event) =>
      event.event.startsWith("batch_run"),
    );
    expect(batchEvents.map((event) => event.event)).toEqual([
      "batch_run_started",
      "batch_run_completed",
    ]);
    expect(batchEvents[1].reason).toContain("3 Claim(s), davon 2");

    expect((await store.verify()).ok).toBe(true);
    expect(
      getExtractionState("proj_extraktion", register, { runner }).status,
    ).toBe("abgeschlossen");
    // The projection reflects the new claims.
    const briefingMd = fs.readFileSync(
      path.join(store.projectDir, "briefing.md"),
      "utf8",
    );
    expect(briefingMd).toContain("clm_0001");
  });

  it("keys live-run state by the routing id, not the register's inner id", async () => {
    // An imported project keeps its chain-bound inner id but can live under
    // a different workspace directory name (TMB-40); runs are submitted and
    // must be looked up under the directory name.
    const runner = createJobRunner();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const handle = runner.submit(
      "projekt-kopie",
      ["briefing"],
      () => "briefing",
      async () => gate,
      { kind: "extraction" },
    );
    const register = await RegisterStore.forProject("proj_extraktion").read();
    expect(
      getExtractionState("projekt-kopie", register, { runner }).status,
    ).toBe("laeuft");
    expect(
      getExtractionState(register.project.id, register, { runner }).status,
    ).toBe("nicht_gestartet");
    release();
    await handle.done;
  });

  it("blocks a second extraction once claims exist", async () => {
    await prepareProject();
    const handle = await startExtraction("proj_extraktion", {
      orchestrator: testOrchestrator(),
      runner: createJobRunner(),
    });
    await handle.done;
    await expect(
      startExtraction("proj_extraktion", {
        orchestrator: testOrchestrator(),
        runner: createJobRunner(),
      }),
    ).rejects.toBeInstanceOf(ExtractionAlreadyRanError);
  });

  it("records a failure completion with zero claims when attempts are exhausted", async () => {
    await prepareProject();
    const crash = new AdapterProcessError("claude", "extraction", 1, "boom");
    const handle = await startExtraction("proj_extraktion", {
      orchestrator: testOrchestrator({ script: [crash, crash] }),
      runner: createJobRunner(),
    });
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 1, failed: 0 });
    const completed = handle
      .eventsSoFar()
      .find((event) => event.type === "item_completed");
    expect(completed).toMatchObject({
      outcome: { status: "ok", result: { outcome: "fehlgeschlagen" } },
    });

    const register = await RegisterStore.forProject("proj_extraktion").read();
    expect(register.claims).toHaveLength(0);
    const lastEvent = register.project_events.at(-1);
    expect(lastEvent?.event).toBe("batch_run_completed");
    expect(lastEvent?.reason).toContain("erschöpft");
    expect(getExtractionState("proj_extraktion", register).status).toBe(
      "fehlgeschlagen",
    );
    // Zero claims written → a retry is allowed.
    await expect(
      startExtraction("proj_extraktion", {
        orchestrator: testOrchestrator(),
        runner: createJobRunner(),
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a bundle referencing unknown sources as a whole", async () => {
    await prepareProject();
    const badOutput: ExtractionOutput = {
      claims: [
        {
          text: "Claim mit unbekannter Quelle.",
          claim_type: "quantitativer_einzelbefund",
          briefing_anchor: "p1",
          evidence: [
            {
              source_id: "src_unbekannt",
              locator: { page: 1 },
              verbatim_excerpt: "irgendein Auszug",
            },
          ],
        },
      ],
    };
    const handle = await startExtraction("proj_extraktion", {
      orchestrator: testOrchestrator({ output: badOutput }),
      runner: createJobRunner(),
    });
    await handle.done;

    const register = await RegisterStore.forProject("proj_extraktion").read();
    expect(register.claims).toHaveLength(0);
    expect(register.project_events.at(-1)?.reason).toContain("zurückgewiesen");
    expect(
      (await RegisterStore.forProject("proj_extraktion").verify()).ok,
    ).toBe(true);
  });
});
