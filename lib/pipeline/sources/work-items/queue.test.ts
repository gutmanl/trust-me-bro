import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../../register";
import {
  DocumentFetchError,
  InvalidSourceInputError,
  PipelineError,
  SourceCorrectionPreconditionError,
  UnknownSourceError,
} from "../../errors";
import { createProject } from "../../projects";
import { recordCaptureFailure } from "./failures";
import {
  enqueueManualCapture,
  enqueueSourceCorrection,
  getSourceWorkItems,
  retryManualCapture,
} from "./queue";
import type { WorkItemQueueDependencies } from "./queue";
import type { SourceCaptureItemInfo, SourceCaptureWorkItem } from "./types";

const PROJECT_ID = "proj_workitem-queue";

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-wi-queue-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT_ID,
    research_question: "Wird sauber eingereiht?",
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

/** Chain fake capturing enqueued items; queued/active are test-controlled. */
function fakeChain(state?: {
  queued?: SourceCaptureItemInfo[];
  active?: SourceCaptureItemInfo;
}): NonNullable<WorkItemQueueDependencies["chain"]> & {
  enqueued: SourceCaptureWorkItem[];
} {
  const enqueued: SourceCaptureWorkItem[] = [];
  return {
    enqueued,
    enqueueSourceCapture(_projectId, item) {
      enqueued.push(item);
    },
    pendingCaptureItems: () => state?.queued ?? [],
    activeCaptureItem: () => state?.active,
  };
}

describe("enqueueManualCapture", () => {
  it("rejects an unrecognizable DOI synchronously", async () => {
    await expect(
      enqueueManualCapture(PROJECT_ID, {
        kind: "doi",
        sourceType: "peer_reviewed_publication",
        identifier: "kein-doi",
      }),
    ).rejects.toThrow(InvalidSourceInputError);
  });

  it("rejects a URL capture without a title synchronously", async () => {
    await expect(
      enqueueManualCapture(PROJECT_ID, {
        kind: "url",
        sourceType: "grey_literature",
        identifier: "https://example.org/report",
      }),
    ).rejects.toThrow(/Titel/);
  });

  it("rejects an upload capture without a document", async () => {
    await expect(
      enqueueManualCapture(PROJECT_ID, {
        kind: "upload",
        sourceType: "grey_literature",
        manual: { title: "Bericht" },
      }),
    ).rejects.toThrow(/Dokument hochgeladen/);
  });

  it("queues a valid DOI capture with a minted work-item id", async () => {
    const chain = fakeChain();
    const { workItemId } = await enqueueManualCapture(
      PROJECT_ID,
      {
        kind: "doi",
        sourceType: "peer_reviewed_publication",
        identifier: "10.1109/TSE.2025.3489012",
      },
      { chain },
    );
    expect(workItemId).toMatch(/^wi_/);
    expect(chain.enqueued).toHaveLength(1);
    expect(chain.enqueued[0]).toMatchObject({
      workItemId,
      origin: "manual",
      label: "10.1109/TSE.2025.3489012",
      request: { kind: "doi", identifier: "10.1109/TSE.2025.3489012" },
    });
  });

  it("carries an explicit document URL alongside the identifier", async () => {
    const chain = fakeChain();
    await enqueueManualCapture(
      PROJECT_ID,
      {
        kind: "doi",
        sourceType: "peer_reviewed_publication",
        identifier: "10.1109/TSE.2025.3489012",
        documentUrl: "https://publisher.example.org/paper.pdf",
      },
      { chain },
    );
    expect(chain.enqueued[0].request).toMatchObject({
      kind: "doi",
      identifier: "10.1109/TSE.2025.3489012",
      documentUrl: "https://publisher.example.org/paper.pdf",
    });
  });

  it("freezes an upload into the blob store so the queue holds no bytes", async () => {
    const chain = fakeChain();
    const content = Buffer.from("%PDF-1.7 fake");
    await enqueueManualCapture(
      PROJECT_ID,
      {
        kind: "upload",
        sourceType: "grey_literature",
        manual: { title: "Grauer Bericht" },
        upload: { content, filename: "bericht.pdf" },
      },
      { chain },
    );
    const request = chain.enqueued[0].request;
    expect(request.uploadBlob?.filename).toBe("bericht.pdf");
    expect(request.uploadBlob?.blob_path).toMatch(/^blobs\//);
    expect(JSON.stringify(request)).not.toContain("content");
    const store = RegisterStore.forProject(PROJECT_ID);
    expect(
      store
        .blobs()
        .read(request.uploadBlob?.blob_path ?? "")
        .equals(content),
    ).toBe(true);
  });
});

describe("enqueueSourceCorrection", () => {
  async function addSource(id: string): Promise<void> {
    await RegisterStore.forProject(PROJECT_ID).transaction((tx) => {
      tx.addSource({
        id,
        type: "document",
        title: "Falsch erfasst",
        custom: { source_type: "preprint" },
      });
    });
  }

  it("rejects an unknown target source", async () => {
    await expect(
      enqueueSourceCorrection(PROJECT_ID, "src_fehlt", {
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
      }),
    ).rejects.toThrow(UnknownSourceError);
  });

  it("queues a correction item carrying the target and its current type", async () => {
    await addSource("src_falsch");
    const chain = fakeChain();
    const { workItemId } = await enqueueSourceCorrection(
      PROJECT_ID,
      "src_falsch",
      { kind: "doi", identifier: "10.1109/TSE.2025.3489012" },
      { chain },
    );
    expect(workItemId).toMatch(/^wi_/);
    expect(chain.enqueued[0]).toMatchObject({
      workItemId,
      origin: "correction",
      request: {
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        targetSourceId: "src_falsch",
        // Inherited from the target — a correction never silently
        // reclassifies.
        sourceType: "preprint",
      },
    });
  });

  it("rejects a second correction while one is queued for the same source", async () => {
    await addSource("src_falsch");
    const chain = fakeChain({
      queued: [
        {
          workItemId: "wi_läuft",
          origin: "correction",
          label: "Korrektur",
          targetSourceId: "src_falsch",
        },
      ],
    });
    await expect(
      enqueueSourceCorrection(
        PROJECT_ID,
        "src_falsch",
        { kind: "doi", identifier: "10.1109/TSE.2025.3489012" },
        { chain },
      ),
    ).rejects.toThrow(SourceCorrectionPreconditionError);
  });

  it("validates the corrected identity synchronously", async () => {
    await addSource("src_falsch");
    await expect(
      enqueueSourceCorrection(PROJECT_ID, "src_falsch", {
        kind: "doi",
        identifier: "kein-doi",
      }),
    ).rejects.toThrow(InvalidSourceInputError);
  });

  it("freezes a corrected upload into the blob store", async () => {
    await addSource("src_falsch");
    const chain = fakeChain();
    const content = Buffer.from("Der richtige Volltext.");
    const { workItemId } = await enqueueSourceCorrection(
      PROJECT_ID,
      "src_falsch",
      {
        kind: "upload",
        sourceType: "grey_literature",
        manual: { title: "Richtiges Paper" },
        upload: { content, filename: "richtig.txt" },
      },
      { chain },
    );
    const request = chain.enqueued[0].request;
    expect(chain.enqueued[0].workItemId).toBe(workItemId);
    expect(request.sourceType).toBe("grey_literature");
    expect(request.uploadBlob?.filename).toBe("richtig.txt");
    expect(
      RegisterStore.forProject(PROJECT_ID)
        .blobs()
        .read(request.uploadBlob?.blob_path ?? "")
        .equals(content),
    ).toBe(true);
  });
});

describe("retryManualCapture", () => {
  it("rejects a work item without an open failure", async () => {
    await expect(retryManualCapture(PROJECT_ID, "wi_unknown")).rejects.toThrow(
      PipelineError,
    );
  });

  it("re-queues a failed correction as a correction, target preserved", async () => {
    await recordCaptureFailure(
      PROJECT_ID,
      {
        workItemId: "wi_korrektur",
        origin: "correction",
        label: "10.1109/TSE.2025.3489012",
        request: {
          kind: "doi",
          sourceType: "preprint",
          targetSourceId: "src_falsch",
          identifier: "10.1109/TSE.2025.3489012",
        },
      },
      new DocumentFetchError("Nicht abrufbar."),
    );
    const chain = fakeChain();
    const { workItemId } = await retryManualCapture(
      PROJECT_ID,
      "wi_korrektur",
      { chain },
    );
    expect(workItemId).toBe("wi_korrektur");
    expect(chain.enqueued[0]).toMatchObject({
      workItemId: "wi_korrektur",
      origin: "correction",
      request: {
        kind: "doi",
        targetSourceId: "src_falsch",
        identifier: "10.1109/TSE.2025.3489012",
      },
    });
  });

  it("re-queues a failed auto-repair attempt, origin preserved", async () => {
    await recordCaptureFailure(
      PROJECT_ID,
      {
        workItemId: "wi_auto",
        origin: "auto_repair",
        label: "Automatisch korrigiert",
        request: {
          kind: "doi",
          sourceType: "peer_reviewed_publication",
          identifier: "10.1109/TSE.2025.3489012",
        },
      },
      new DocumentFetchError("Kein PDF gefunden."),
    );
    const chain = fakeChain();
    await retryManualCapture(PROJECT_ID, "wi_auto", { chain });
    expect(chain.enqueued[0]).toMatchObject({
      workItemId: "wi_auto",
      origin: "auto_repair",
      request: { kind: "doi", identifier: "10.1109/TSE.2025.3489012" },
    });
  });

  it("re-queues a frozen upload by blob reference, nothing re-uploaded", async () => {
    const blob = RegisterStore.forProject(PROJECT_ID)
      .blobs()
      .put(Buffer.from("%PDF-1.7 fake"), "pdf");
    await recordCaptureFailure(
      PROJECT_ID,
      {
        workItemId: "wi_upload",
        origin: "manual",
        label: "Bericht",
        request: {
          kind: "upload",
          sourceType: "grey_literature",
          manual: { title: "Bericht" },
          uploadBlob: { blob_path: blob.blobPath, filename: "bericht.pdf" },
        },
      },
      new DocumentFetchError("Extraktion abgebrochen."),
    );
    const chain = fakeChain();
    await retryManualCapture(PROJECT_ID, "wi_upload", { chain });
    expect(chain.enqueued[0].request.uploadBlob).toEqual({
      blob_path: blob.blobPath,
      filename: "bericht.pdf",
    });
  });

  it("re-queues the recorded input snapshot under the same id", async () => {
    await recordCaptureFailure(
      PROJECT_ID,
      {
        workItemId: "wi_again",
        origin: "manual",
        label: "Nochmal",
        request: {
          kind: "url",
          sourceType: "vendor_documentation",
          identifier: "https://example.org/doc",
          documentUrl: "https://example.org/doc.pdf",
          manual: { title: "Herstellerdoku" },
        },
      },
      new DocumentFetchError("Zeitüberschreitung."),
    );
    const chain = fakeChain();
    const { workItemId } = await retryManualCapture(PROJECT_ID, "wi_again", {
      chain,
    });
    expect(workItemId).toBe("wi_again");
    expect(chain.enqueued[0]).toMatchObject({
      workItemId: "wi_again",
      origin: "manual",
      label: "Herstellerdoku",
      request: {
        kind: "url",
        identifier: "https://example.org/doc",
        documentUrl: "https://example.org/doc.pdf",
        manual: { title: "Herstellerdoku" },
      },
    });
  });
});

describe("getSourceWorkItems", () => {
  it("orders capturing before queued before failed, deduplicating by id", async () => {
    await recordCaptureFailure(
      PROJECT_ID,
      {
        workItemId: "wi_failed",
        origin: "manual",
        label: "Fehlgeschlagen",
        request: { kind: "doi", sourceType: "preprint", identifier: "10.1/x" },
      },
      new DocumentFetchError("Nicht abrufbar."),
    );
    // A stale failure of the item currently retrying must stay hidden.
    await recordCaptureFailure(
      PROJECT_ID,
      {
        workItemId: "wi_active",
        origin: "manual",
        label: "Aktiv",
        request: { kind: "doi", sourceType: "preprint", identifier: "10.1/y" },
      },
      new DocumentFetchError("Alt."),
    );
    const register = await RegisterStore.forProject(PROJECT_ID).read();
    const rows = getSourceWorkItems(PROJECT_ID, register, {
      chain: fakeChain({
        active: { workItemId: "wi_active", origin: "manual", label: "Aktiv" },
        queued: [
          { workItemId: "wi_queued", origin: "reference_import", label: "Q" },
          // Defensive duplicate of the active item: must not render twice.
          { workItemId: "wi_active", origin: "manual", label: "Aktiv" },
        ],
      }),
    });
    expect(rows.map((row) => [row.workItemId, row.status])).toEqual([
      ["wi_active", "capturing"],
      ["wi_queued", "queued"],
      ["wi_failed", "failed"],
    ]);
    const failed = rows.find((row) => row.status === "failed");
    expect(failed?.error).toBe("Nicht abrufbar.");
  });

  it("labels a failed upload correction by its filename and keeps the target", async () => {
    const blob = RegisterStore.forProject(PROJECT_ID)
      .blobs()
      .put(Buffer.from("%PDF-1.7 fake"), "pdf");
    await recordCaptureFailure(
      PROJECT_ID,
      {
        workItemId: "wi_upload_korrektur",
        origin: "correction",
        label: "richtig.pdf",
        request: {
          kind: "upload",
          sourceType: "grey_literature",
          targetSourceId: "src_falsch",
          uploadBlob: { blob_path: blob.blobPath, filename: "richtig.pdf" },
        },
      },
      new DocumentFetchError("Extraktion abgebrochen."),
    );
    const register = await RegisterStore.forProject(PROJECT_ID).read();
    const rows = getSourceWorkItems(PROJECT_ID, register, {
      chain: fakeChain(),
    });
    expect(rows).toHaveLength(1);
    // No manual title, no identifier — the frozen upload's filename labels.
    expect(rows[0].label).toBe("richtig.pdf");
    expect(rows[0].targetSourceId).toBe("src_falsch");
    expect(rows[0].status).toBe("failed");
  });

  it("keeps reference-import failures visible with their reason", async () => {
    await recordCaptureFailure(
      PROJECT_ID,
      {
        workItemId: "cand_1",
        origin: "reference_import",
        label: "Kandidat",
        request: { kind: "doi", sourceType: "preprint", identifier: "10.1/z" },
      },
      new DocumentFetchError("Kein PDF."),
    );
    const register = await RegisterStore.forProject(PROJECT_ID).read();
    const rows = getSourceWorkItems(PROJECT_ID, register, {
      chain: fakeChain(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("reference_import");
    expect(rows[0].error).toBe("Kein PDF.");
  });
});
