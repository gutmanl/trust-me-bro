import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProject, importBriefing } from "@/lib/pipeline";
import { RegisterStore } from "@/lib/register";
import { createAutoChain } from "@/lib/pipeline/runs/auto-chain";
import { createJobRunner } from "@/lib/pipeline/runs/job-runner";
import type { JobRunner } from "@/lib/pipeline/runs/job-runner";
import type { SourceExtractionSummary } from "@/lib/pipeline/extraction/run-source-extraction";
import type { ExistenceCheckItemResult } from "@/lib/pipeline/verification/run-existence-check";
import type { RunHandle } from "@/lib/pipeline/runs/types";

/**
 * The workbench's briefing publish action, at the seam the backfill lives on
 * (workbench epic): capturing a source always enqueues its extraction pass,
 * but on a project without a briefing that pass fails its precondition and
 * the auto-chain drops it with a warning. Nothing re-triggered those sources
 * when the briefing arrived afterwards — the INITIAL import now does.
 *
 * The action is exercised for real (real register on disk, real
 * publishBriefingRevision); only the barrel's `enqueueSourceExtraction` is
 * redirected into a locally built auto-chain with fake start-fns, so the
 * assertion is "an extraction run lands for the source" without spawning a
 * backend CLI.
 */

const { enqueue, enqueueScan } = vi.hoisted(() => ({
  enqueue: vi.fn(),
  enqueueScan: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pipeline")>()),
  enqueueSourceExtraction: enqueue,
  enqueueReferenceScan: enqueueScan,
}));

const PROJECT = "proj_workbench_actions";
const BRIEFING = [
  "Absatz eins: LLM-gestützte Code-Reviews verändern den Prozess.",
  "Absatz zwei: Die mediane Reviewzeit sinkt um 55 %.",
].join("\n\n");

const extractionSummary: SourceExtractionSummary = {
  outcome: "completed",
  created: 0,
  merged: 0,
  message: "ok",
};

const existenceCheckResult: ExistenceCheckItemResult = {
  claimId: "clm_1",
  passed: true,
  message: "ok",
};

let workspace: string;
let runner: JobRunner;
let startSourceExtraction: ReturnType<typeof fakeExtraction>;

/** Start-fn fake going through a REAL job runner, exactly like the
 * auto-chain's own tests: "the run landed" is then an actual submitted run,
 * not just a queued trigger. */
function fakeExtraction(target: JobRunner) {
  return vi.fn(
    async (
      projectId: string,
      sourceId: string,
      deps?: { runner?: JobRunner },
    ): Promise<RunHandle<SourceExtractionSummary>> =>
      (deps?.runner ?? target).submit(
        projectId,
        [sourceId],
        (id) => id,
        async () => extractionSummary,
        { kind: "extraction" },
      ),
  );
}

function fakeExistenceCheck(target: JobRunner) {
  return vi.fn(
    async (
      projectId: string,
      deps?: { runner?: JobRunner },
    ): Promise<RunHandle<ExistenceCheckItemResult>> =>
      (deps?.runner ?? target).submit(
        projectId,
        ["existence_check_item"],
        (id) => id,
        async () => existenceCheckResult,
        { kind: "existence_check" },
      ),
  );
}

/** A minimal captured source — snapshot-less on purpose: the backfill only
 * ever reads the register's source ids. */
async function addSource(id: string): Promise<void> {
  await RegisterStore.forProject(PROJECT).transaction((tx) => {
    tx.addSource({
      id,
      type: "article-journal",
      title: `Studie ${id}`,
      custom: { source_type: "preprint" },
    });
  });
}

function publishForm(text: string, tool?: string): FormData {
  const form = new FormData();
  form.set("text", text);
  if (tool !== undefined) {
    form.set("tool", tool);
  }
  return form;
}

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-workbench-actions-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });

  runner = createJobRunner();
  startSourceExtraction = fakeExtraction(runner);
  const chain = createAutoChain({
    runner,
    startSourceExtraction,
    startExistenceCheck: fakeExistenceCheck(runner),
  });
  enqueue.mockReset();
  enqueue.mockImplementation((projectId: string, sourceId: string) => {
    chain.enqueueSourceExtraction(projectId, sourceId);
  });
  // Only the wiring is under test here — that the publish action asks for a
  // scan, and when. The chain's own reference triggers have their own tests.
  enqueueScan.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("publishBriefingRevisionAction — extraction backfill", () => {
  it("runs the dropped extraction pass of every source once the initial briefing arrives", async () => {
    const { publishBriefingRevisionAction } = await import("./actions");
    await addSource("src_a");
    await addSource("src_b");

    const state = await publishBriefingRevisionAction(
      PROJECT,
      { error: null },
      publishForm(BRIEFING, "you.com"),
    );
    expect(state).toEqual({ error: null, published: true });

    await vi.waitFor(() => {
      expect(startSourceExtraction).toHaveBeenCalledTimes(2);
    });
    expect(startSourceExtraction).toHaveBeenCalledWith(PROJECT, "src_a", {
      runner,
    });
    expect(startSourceExtraction).toHaveBeenCalledWith(PROJECT, "src_b", {
      runner,
    });
  });

  it("does not backfill an ordinary revision of an existing briefing", async () => {
    const { publishBriefingRevisionAction } = await import("./actions");
    await importBriefing({
      projectId: PROJECT,
      content: BRIEFING,
      tool: "you.com",
    });
    await addSource("src_a");

    const state = await publishBriefingRevisionAction(
      PROJECT,
      { error: null },
      publishForm(`${BRIEFING}\n\nAbsatz drei: neu.`),
    );
    expect(state).toEqual({ error: null, published: true });

    expect(enqueue).not.toHaveBeenCalled();
    expect(startSourceExtraction).not.toHaveBeenCalled();
  });

  it("enqueues nothing when the initial import finds no sources", async () => {
    const { publishBriefingRevisionAction } = await import("./actions");

    await publishBriefingRevisionAction(
      PROJECT,
      { error: null },
      publishForm(BRIEFING, "you.com"),
    );

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not backfill when publishing fails", async () => {
    const { publishBriefingRevisionAction } = await import("./actions");
    await addSource("src_a");

    // No tool name on the initial-import path: refused by the use-case.
    const state = await publishBriefingRevisionAction(
      PROJECT,
      { error: null },
      publishForm(BRIEFING),
    );
    expect(state.error).not.toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

/**
 * The other half of the publish action: a briefing must arrive with the
 * sources it cites, instead of sitting in front of an empty source list
 * while the workbench reports nothing waiting for adjudication.
 */
describe("publishBriefingRevisionAction — reference scan", () => {
  it("scans the briefing on the initial import", async () => {
    const { publishBriefingRevisionAction } = await import("./actions");

    await publishBriefingRevisionAction(
      PROJECT,
      { error: null },
      publishForm(BRIEFING, "you.com"),
    );

    expect(enqueueScan).toHaveBeenCalledExactlyOnceWith(PROJECT);
  });

  it("scans again after a revision that changed the text", async () => {
    const { publishBriefingRevisionAction } = await import("./actions");
    await importBriefing({
      projectId: PROJECT,
      content: BRIEFING,
      tool: "you.com",
    });

    await publishBriefingRevisionAction(
      PROJECT,
      { error: null },
      publishForm(
        `${BRIEFING}\n\nAbsatz drei: eine neue Quelle, doi:10.1000/x.`,
      ),
    );

    expect(enqueueScan).toHaveBeenCalledExactlyOnceWith(PROJECT);
  });

  it("does not scan when the republished text is identical", async () => {
    const { publishBriefingRevisionAction } = await import("./actions");
    await importBriefing({
      projectId: PROJECT,
      content: BRIEFING,
      tool: "you.com",
    });

    // Checksum-identical republish: a total no-op in the use-case, so the
    // text a scan would read is the text the last scan already read.
    const state = await publishBriefingRevisionAction(
      PROJECT,
      { error: null },
      publishForm(BRIEFING),
    );

    expect(state).toEqual({ error: null, published: true });
    expect(enqueueScan).not.toHaveBeenCalled();
  });

  it("does not scan when publishing fails", async () => {
    const { publishBriefingRevisionAction } = await import("./actions");

    const state = await publishBriefingRevisionAction(
      PROJECT,
      { error: null },
      publishForm(BRIEFING),
    );

    expect(state.error).not.toBeNull();
    expect(enqueueScan).not.toHaveBeenCalled();
  });
});

describe("publishBriefingRevisionAction — companion BibTeX file", () => {
  const BIB = [
    "@online{coaudit2023,",
    "  title = {Co-audit: tools to help humans double-check AI content},",
    "  eprint = {2310.01297},",
    "  eprinttype = {arxiv},",
    "}",
  ].join("\n");
  const PANDOC =
    "Werkzeuge zum Gegenlesen von KI-Ausgaben sind ein eigenes Feld [@coaudit2023].";

  function bibForm(text: string, bib: string, tool?: string): FormData {
    const form = publishForm(text, tool);
    form.set("bibliography", new File([bib], "bibliography.bib"));
    return form;
  }

  it("freezes the desugared text and returns the German report", async () => {
    const { publishBriefingRevisionAction } = await import("./actions");

    const state = await publishBriefingRevisionAction(
      PROJECT,
      { error: null },
      bibForm(PANDOC, BIB, "pandoc"),
    );

    expect(state.error).toBeNull();
    expect(state.citationReport?.summary).toBe(
      "1 Zitation aus 1 Eintrag in 1 Fußnote überführt.",
    );

    const register = await RegisterStore.forProject(PROJECT).read();
    const meta = register.project.briefing_import;
    const frozen = RegisterStore.forProject(PROJECT)
      .blobs()
      .readText(meta!.blob_path);
    expect(frozen).toContain("eigenes Feld [^coaudit2023].");
    expect(frozen).toContain("arXiv:2310.01297");
  });

  it("ignores an empty file input", async () => {
    const { publishBriefingRevisionAction } = await import("./actions");
    const form = publishForm(BRIEFING, "you.com");
    form.set("bibliography", new File([], "bibliography.bib"));

    const state = await publishBriefingRevisionAction(
      PROJECT,
      { error: null },
      form,
    );
    expect(state).toEqual({ error: null, published: true });
  });
});
