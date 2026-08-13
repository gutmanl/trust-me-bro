import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../../register";
import {
  DocumentFetchError,
  InvalidSourceInputError,
  PipelineError,
} from "../../errors";
import { createProject } from "../../projects";
import { recordCaptureFailure } from "./failures";
import {
  enqueueManualCapture,
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

  it("re-uses the frozen blob when a retry arrives without a fresh upload", async () => {
    const chain = fakeChain();
    const store = RegisterStore.forProject(PROJECT_ID);
    const blob = store.blobs().put(Buffer.from("%PDF-1.7 alt"), "pdf");
    await recordCaptureFailure(
      PROJECT_ID,
      {
        workItemId: "wi_retry-upload",
        origin: "manual",
        label: "Alt",
        request: {
          kind: "upload",
          sourceType: "grey_literature",
          manual: { title: "Alt" },
          uploadBlob: { blob_path: blob.blobPath, filename: "alt.pdf" },
        },
      },
      new DocumentFetchError("Extraktion fehlgeschlagen."),
    );
    await enqueueManualCapture(
      PROJECT_ID,
      {
        kind: "upload",
        sourceType: "grey_literature",
        manual: { title: "Alt, korrigiert" },
      },
      { chain, retryOf: "wi_retry-upload" },
    );
    expect(chain.enqueued[0].workItemId).toBe("wi_retry-upload");
    expect(chain.enqueued[0].request.uploadBlob).toEqual({
      blob_path: blob.blobPath,
      filename: "alt.pdf",
    });
  });
});

describe("retryManualCapture", () => {
  it("rejects a work item without an open failure", async () => {
    await expect(retryManualCapture(PROJECT_ID, "wi_unknown")).rejects.toThrow(
      PipelineError,
    );
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
    expect(failed?.retryInput?.identifier).toBe("10.1/x");
  });

  it("attaches no retry input to reference-import failures", async () => {
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
    expect(rows[0].retryInput).toBeUndefined();
  });
});
