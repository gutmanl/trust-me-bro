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
  CROSSREF_WORK_UNSPECIFIED_PDF_LINK_RESPONSE,
  CROSSREF_WORK_WITH_PDF_LINK_RESPONSE,
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

  it("queries the scan's resolved title, not the citing paragraph", async () => {
    // The real shape that defeated the repair: `raw_text` is the briefing
    // PARAGRAPH citing the work, which names no title at all — so the
    // parser has nothing to extract and the deterministic floor would hand
    // Crossref a paragraph of prose. The scan already resolved a proper
    // citation line for the same candidate; that is what must be queried.
    const paragraph =
      "**Semantisches Chunking** wird als Mechanismus berichtet: In einer " +
      "fMRI-Studie fanden Siegmund et al. „evidence of semantic chunking“ " +
      "(Abstract). DOI: https://doi.org/10.9999/halluziniert.123 [^1]";
    await recordReferenceImportFailure(
      "cnd_para",
      "10.9999/halluziniert.123",
      paragraph,
    );
    const store = RegisterStore.forProject(PROJECT);
    await store.transaction((tx) => {
      const blob = store.blobs().put(
        JSON.stringify({
          scanned_at: new Date().toISOString(),
          method: "regex",
          candidates: [
            {
              candidate_id: "cnd_para",
              raw_text: paragraph,
              method: "doi",
              doi: "10.9999/halluziniert.123",
              title: REAL_TITLE,
              suggested_source_type: "peer_reviewed_publication",
            },
          ],
        }),
        "json",
      );
      tx.recordReferenceScan({
        sha256: blob.sha256,
        blob_path: blob.blobPath,
        method: "regex",
        candidate_count: 1,
        actor: "system:reference_scan",
        reason: "Test-Scan.",
      });
    });

    const parsed: string[] = [];
    const recordingOrchestrator = {
      run: async (
        _backendId: string,
        job: { input: { briefing_text: string } },
      ) => {
        parsed.push(job.input.briefing_text);
        return {
          status: "ok",
          output: {
            references: [
              {
                raw_text: REAL_TITLE,
                title: REAL_TITLE,
                authors: ["Anna Meyer"],
                year: 2025,
              },
            ],
          },
        };
      },
    } as unknown as Orchestrator;

    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "cnd_para", {
      fetcher: crossrefFetcher(),
      orchestrator: recordingOrchestrator,
      chain,
    });

    // The heart of it: the parser was handed the scan's citation line, not
    // the paragraph that contains no title.
    expect(parsed).toEqual([REAL_TITLE]);
    expect(parsed[0]).not.toContain("Semantisches Chunking");
    // The persisted provenance stays the ORIGINAL paragraph: the review
    // keys already-captured detection on raw_text + method.
    expect(chain.enqueued[0]?.request.autoCapture?.raw_text).toBe(paragraph);
  });

  it("falls back to the raw text when the scan no longer knows the candidate", async () => {
    await recordReferenceImportFailure();
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "cand_0001", {
      fetcher: crossrefFetcher(),
      orchestrator: parseOrchestrator,
      chain,
    });

    // No scan pointer at all in this project — the raw citation line still
    // carries the repair, exactly as before.
    expect(chain.enqueued[0]?.request).toMatchObject({
      identifier: "10.1109/TSE.2025.3489012",
    });
  });

  it("repairs a MANUAL failure from its form metadata, with no backend at all", async () => {
    await recordCaptureFailure(
      PROJECT,
      {
        workItemId: "wi_manual",
        origin: "manual",
        label: "Von Hand",
        request: {
          kind: "doi",
          sourceType: "peer_reviewed_publication",
          identifier: "10.9999/vertippt.7",
          manual: {
            title: REAL_TITLE,
            authors: "Meyer, Anna",
            year: "2025",
          },
        },
      },
      new Error("DOI nicht auflösbar."),
    );
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "wi_manual", {
      fetcher: crossrefFetcher(),
      // No orchestrator and an unusable backend: the form fields ARE the
      // metadata, so a manual repair must never need the LLM parse.
      preflight: async () => ({ usable: false, hint: "Test" }),
      chain,
    });

    const register = await RegisterStore.forProject(PROJECT).read();
    const event = register.project_events.find(
      (candidate) => candidate.event === "source_repair_action",
    );
    expect(event?.repair_action).toMatchObject({
      mode: "applied",
      basis: "capture_failure_rematch",
      target: { kind: "capture_failure", work_item_id: "wi_manual" },
    });
    expect(chain.enqueued[0]).toMatchObject({
      workItemId: "wi_manual",
      origin: "auto_repair",
      request: {
        identifier: "10.1109/TSE.2025.3489012",
        // Provenance stays manual: the repaired attempt must not be
        // restamped as an auto-import.
        manual: { title: REAL_TITLE },
      },
    });
    expect(chain.enqueued[0]?.request.autoCapture).toBeUndefined();
  });

  it("keeps a CORRECTION's target, so the repair replaces rather than adds", async () => {
    await recordCaptureFailure(
      PROJECT,
      {
        workItemId: "wi_correction",
        origin: "correction",
        label: "Korrektur",
        request: {
          kind: "doi",
          sourceType: "peer_reviewed_publication",
          targetSourceId: "src_falsch",
          identifier: "10.9999/auch-falsch.1",
          manual: { title: REAL_TITLE, authors: "Meyer, Anna", year: "2025" },
        },
      },
      new Error("DOI nicht auflösbar."),
    );
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "wi_correction", {
      fetcher: crossrefFetcher(),
      preflight: async () => ({ usable: false, hint: "Test" }),
      chain,
    });

    expect(chain.enqueued[0]?.request).toMatchObject({
      targetSourceId: "src_falsch",
      identifier: "10.1109/TSE.2025.3489012",
    });
  });

  it("records nothing when a manual failure has no metadata to rematch on", async () => {
    await recordCaptureFailure(
      PROJECT,
      {
        workItemId: "wi_upload",
        origin: "manual",
        label: "Nur Upload",
        request: {
          kind: "upload",
          sourceType: "peer_reviewed_publication",
          uploadBlob: {
            blob_path: `blobs/ab/ab${"c".repeat(62)}.pdf`,
            filename: "p.pdf",
          },
        },
      },
      new Error("Textextraktion fehlgeschlagen."),
    );
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "wi_upload", {
      fetcher: crossrefFetcher(),
      orchestrator: parseOrchestrator,
      chain,
    });

    const register = await RegisterStore.forProject(PROJECT).read();
    expect(
      register.project_events.some(
        (candidate) => candidate.event === "source_repair_action",
      ),
    ).toBe(false);
    expect(chain.enqueued).toHaveLength(0);
  });

  it("inherits the failed attempt's document URL when none can be derived", async () => {
    // The closed-access case: the identity is repairable, but no PDF is
    // derivable for the corrected DOI. An author copy was already on file
    // from the failed attempt, so the repair carries it over rather than
    // stalling on "please supply a document" — behind expectedExt, which is
    // the only thing standing between it and the frozen corpus.
    await recordCaptureFailure(
      PROJECT,
      {
        workItemId: "cnd_paywalled",
        origin: "reference_import",
        label: "Kandidat",
        request: {
          kind: "doi",
          sourceType: "peer_reviewed_publication",
          identifier: "10.9999/halluziniert.123",
          documentUrl: "https://author.example.org/papers/preprint.pdf",
          autoCapture: { raw_text: RAW_TEXT, method: "doi" },
        },
      },
      new Error("DOI nicht auflösbar."),
    );
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "cnd_paywalled", {
      // CROSSREF_WORK_NO_LINK_RESPONSE on the /works/ route: the rematch
      // succeeds, the document derivation finds nothing.
      fetcher: crossrefFetcher(),
      orchestrator: parseOrchestrator,
      chain,
    });

    expect(chain.enqueued[0]?.request).toMatchObject({
      identifier: "10.1109/TSE.2025.3489012",
      documentUrl: "https://author.example.org/papers/preprint.pdf",
      expectedExt: "pdf",
    });
  });

  it("prefers the attempt's own URL over a merely PDF-shaped guess", async () => {
    // The regression this pins: a guessed publisher link (Crossref
    // content-type "unspecified") is usually a paywall answering 403. It
    // must never displace the URL a human already supplied, which for a
    // closed-access work is typically the only reachable copy.
    await recordCaptureFailure(
      PROJECT,
      {
        workItemId: "cnd_guess",
        origin: "reference_import",
        label: "Kandidat",
        request: {
          kind: "doi",
          sourceType: "peer_reviewed_publication",
          identifier: "10.9999/halluziniert.123",
          documentUrl: "https://author.example.org/papers/preprint.pdf",
          autoCapture: { raw_text: RAW_TEXT, method: "doi" },
        },
      },
      new Error("DOI nicht auflösbar."),
    );
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "cnd_guess", {
      fetcher: fakeFetcher({
        "https://api.crossref.org/works?": {
          contentType: "application/json",
          body: Buffer.from(CROSSREF_WORKS_RESPONSE),
        },
        // The /works/<doi> read that derives the document returns only
        // PDF-SHAPED links with unspecified content-type.
        "https://api.crossref.org/works/": {
          contentType: "application/json",
          body: Buffer.from(CROSSREF_WORK_UNSPECIFIED_PDF_LINK_RESPONSE),
        },
      }),
      orchestrator: parseOrchestrator,
      chain,
    });

    expect(chain.enqueued[0]?.request).toMatchObject({
      documentUrl: "https://author.example.org/papers/preprint.pdf",
      expectedExt: "pdf",
    });
  });

  it("still lets an asserted PDF link win over the attempt's own URL", async () => {
    await recordCaptureFailure(
      PROJECT,
      {
        workItemId: "cnd_asserted",
        origin: "reference_import",
        label: "Kandidat",
        request: {
          kind: "doi",
          sourceType: "peer_reviewed_publication",
          identifier: "10.9999/halluziniert.123",
          documentUrl: "https://author.example.org/papers/preprint.pdf",
          autoCapture: { raw_text: RAW_TEXT, method: "doi" },
        },
      },
      new Error("DOI nicht auflösbar."),
    );
    const chain = chainFake();
    await evaluateCaptureFailureRepair(PROJECT, "cnd_asserted", {
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

    expect(chain.enqueued[0]?.request.documentUrl).toBe(
      "https://publisher.example.org/paper.pdf",
    );
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

  it("does not revive a failure dismissed while the evaluation was in flight", async () => {
    await recordReferenceImportFailure();
    const chain = chainFake();
    // The LLM parse is the slow middle of the evaluation — dismissing the
    // failure inside it simulates the human racing the automatic repair.
    const racingOrchestrator = {
      run: async () => {
        const { dismissCaptureFailure } =
          await import("../work-items/failures");
        await dismissCaptureFailure(PROJECT, "cand_0001");
        return (
          parseOrchestrator as unknown as { run: () => Promise<unknown> }
        ).run();
      },
    } as unknown as Orchestrator;
    await evaluateCaptureFailureRepair(PROJECT, "cand_0001", {
      fetcher: crossrefFetcher(),
      orchestrator: racingOrchestrator,
      chain,
    });
    const register = await RegisterStore.forProject(PROJECT).read();
    // The TOCTOU re-check under the lock swallowed the late result: no
    // suggestion, no auto-applied re-capture of the dismissed item.
    expect(
      register.project_events.filter(
        (candidate) => candidate.event === "source_repair_action",
      ),
    ).toHaveLength(0);
    expect(chain.enqueued).toHaveLength(0);
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
