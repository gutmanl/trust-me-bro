import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Orchestrator } from "../../../adapters";
import { RegisterStore } from "../../../register";
import { createProject } from "../../projects";
import {
  CROSSREF_WORKS_RESPONSE,
  CROSSREF_WORK_NO_LINK_RESPONSE,
  fakeFetcher,
} from "../__fixtures__/fake-fetcher";
import { recordCaptureFailure } from "../work-items/failures";
import type {
  SourceCaptureItemInfo,
  SourceCaptureWorkItem,
} from "../work-items/types";
import { evaluateCaptureFailureRepair } from "./evaluate-capture-failure";

const PROJECT = "proj_auto-repair-a";
const RAW_TEXT = "Meyer et al. zeigen dies (doi:10.9999/halluziniert.123).[^1]";
const REAL_TITLE = "Effects of AI Assistants on Code Review Duration";

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-repair-a-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Wird automatisch repariert?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function chainFake(): {
  enqueued: SourceCaptureWorkItem[];
  enqueueSourceCapture: (p: string, item: SourceCaptureWorkItem) => void;
  pendingCaptureItems: () => SourceCaptureItemInfo[];
  activeCaptureItem: () => SourceCaptureItemInfo | undefined;
} {
  const enqueued: SourceCaptureWorkItem[] = [];
  return {
    enqueued,
    enqueueSourceCapture: (_p, item) => {
      enqueued.push(item);
    },
    pendingCaptureItems: () => [],
    activeCaptureItem: () => undefined,
  };
}

function crossrefFetcher() {
  return fakeFetcher({
    "https://api.crossref.org/works?": {
      contentType: "application/json",
      body: Buffer.from(CROSSREF_WORKS_RESPONSE),
    },
    "https://api.crossref.org/works/": {
      contentType: "application/json",
      body: Buffer.from(CROSSREF_WORK_NO_LINK_RESPONSE),
    },
  });
}

/** LLM parse returning the clean citation, for a confident rematch. */
const parseOrchestrator = {
  run: async () => ({
    status: "ok",
    output: {
      references: [
        {
          raw_text: RAW_TEXT,
          title: REAL_TITLE,
          authors: ["Anna Meyer"],
          year: 2025,
        },
      ],
    },
  }),
} as unknown as Orchestrator;

async function recordReferenceImportFailure(
  workItemId = "cand_0001",
  identifier = "10.9999/halluziniert.123",
  rawText = RAW_TEXT,
): Promise<void> {
  await recordCaptureFailure(
    PROJECT,
    {
      workItemId,
      origin: "reference_import",
      label: "Kandidat",
      request: {
        kind: "doi",
        sourceType: "peer_reviewed_publication",
        identifier,
        autoCapture: { raw_text: rawText, method: "doi" },
      },
    },
    new Error("DOI nicht auflösbar."),
  );
}

describe("evaluateCaptureFailureRepair", () => {
  it("applies a confident rematch: repair event + re-enqueued attempt under the same id", async () => {
    await recordReferenceImportFailure();
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "cand_0001", {
      fetcher: crossrefFetcher(),
      orchestrator: parseOrchestrator,
      chain,
    });

    const register = await RegisterStore.forProject(PROJECT).read();
    const event = register.project_events.find(
      (candidate) => candidate.event === "source_repair_action",
    );
    expect(event?.repair_action).toMatchObject({
      mode: "applied",
      basis: "capture_failure_rematch",
      target: { kind: "capture_failure", work_item_id: "cand_0001" },
      candidate: { kind: "doi", identifier: "10.1109/TSE.2025.3489012" },
    });
    expect(chain.enqueued).toHaveLength(1);
    expect(chain.enqueued[0]).toMatchObject({
      workItemId: "cand_0001",
      origin: "auto_repair",
      request: {
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        autoCapture: { raw_text: RAW_TEXT, method: "crossref_title" },
      },
    });
  });

  it("only suggests below the confidence bar (no LLM: title-only match)", async () => {
    // The deterministic fallback yields only the title (no year/author),
    // capping the score at 0.6 — above the floor, below the bar.
    await recordReferenceImportFailure(
      "cand_0001",
      "10.9999/halluziniert.123",
      REAL_TITLE,
    );
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "cand_0001", {
      fetcher: crossrefFetcher(),
      preflight: async () => ({ usable: false, hint: "Test" }),
      chain,
    });

    const register = await RegisterStore.forProject(PROJECT).read();
    const event = register.project_events.find(
      (candidate) => candidate.event === "source_repair_action",
    );
    expect(event?.repair_action?.mode).toBe("suggested");
    expect(chain.enqueued).toHaveLength(0);
  });

  it("never triggers on an auto_repair-origin failure (loop guard)", async () => {
    await recordCaptureFailure(
      PROJECT,
      {
        workItemId: "cand_0002",
        origin: "auto_repair",
        label: "Reparaturversuch",
        request: {
          kind: "doi",
          sourceType: "peer_reviewed_publication",
          identifier: "10.1109/TSE.2025.3489012",
          autoCapture: { raw_text: RAW_TEXT, method: "crossref_title" },
        },
      },
      new Error("Auch der Reparaturversuch scheiterte."),
    );
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "cand_0002", {
      fetcher: crossrefFetcher(),
      orchestrator: parseOrchestrator,
      chain,
    });
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(
      register.project_events.filter(
        (candidate) => candidate.event === "source_repair_action",
      ),
    ).toHaveLength(0);
    expect(chain.enqueued).toHaveLength(0);
  });

  it("records nothing when the rematch returns the identifier that already failed", async () => {
    await recordReferenceImportFailure("cand_0003", "10.1109/TSE.2025.3489012");
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "cand_0003", {
      fetcher: crossrefFetcher(),
      orchestrator: parseOrchestrator,
      chain,
    });
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(
      register.project_events.filter(
        (candidate) => candidate.event === "source_repair_action",
      ),
    ).toHaveLength(0);
    expect(chain.enqueued).toHaveLength(0);
  });

  it("carries a derived document URL into the applied attempt", async () => {
    await recordReferenceImportFailure();
    const chain = chainFake();
    const { CROSSREF_WORK_WITH_PDF_LINK_RESPONSE } =
      await import("../__fixtures__/fake-fetcher");
    await evaluateCaptureFailureRepair(PROJECT, "cand_0001", {
      fetcher: fakeFetcher({
        "https://api.crossref.org/works?": {
          contentType: "application/json",
          body: Buffer.from(CROSSREF_WORKS_RESPONSE),
        },
        "https://api.crossref.org/works/": {
          contentType: "application/json",
          body: Buffer.from(CROSSREF_WORK_WITH_PDF_LINK_RESPONSE),
        },
      }),
      orchestrator: parseOrchestrator,
      chain,
    });
    const register = await RegisterStore.forProject(PROJECT).read();
    const event = register.project_events.find(
      (candidate) => candidate.event === "source_repair_action",
    );
    expect(event?.repair_action?.candidate.document_url).toBe(
      "https://publisher.example.org/paper.pdf",
    );
    expect(chain.enqueued[0]?.request.documentUrl).toBe(
      "https://publisher.example.org/paper.pdf",
    );
  });

  it("leaves an already re-queued item alone", async () => {
    await recordReferenceImportFailure();
    const chain = {
      ...chainFake(),
      pendingCaptureItems: (): SourceCaptureItemInfo[] => [
        { workItemId: "cand_0001", origin: "auto_repair", label: "läuft" },
      ],
    };
    await evaluateCaptureFailureRepair(PROJECT, "cand_0001", {
      fetcher: crossrefFetcher(),
      orchestrator: parseOrchestrator,
      chain,
    });
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(
      register.project_events.filter(
        (candidate) => candidate.event === "source_repair_action",
      ),
    ).toHaveLength(0);
  });

  it("records nothing when Crossref is unavailable", async () => {
    await recordReferenceImportFailure();
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "cand_0001", {
      fetcher: fakeFetcher({}),
      orchestrator: parseOrchestrator,
      chain,
    });
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(
      register.project_events.filter(
        (candidate) => candidate.event === "source_repair_action",
      ),
    ).toHaveLength(0);
    expect(chain.enqueued).toHaveLength(0);
  });
});
