import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../../register";
import { createProject } from "../../projects";
import { createJobRunner } from "../../runs/job-runner";
import { CSL_JSON_RESPONSE, fakeFetcher } from "../__fixtures__/fake-fetcher";
import {
  getSourceCaptureRun,
  startSourceCaptureItem,
  toCaptureSourceInput,
} from "./run-item";
import type { SourceCaptureWorkItem } from "./types";

const PROJECT_ID = "proj_workitem-run";
const PDF_BYTES = Buffer.from("%PDF-1.7 fake");

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-wi-run-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT_ID,
    research_question: "Läuft ein Arbeitsposten durch?",
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

function doiItem(workItemId: string): SourceCaptureWorkItem {
  return {
    workItemId,
    origin: "manual",
    label: "Meyer 2025",
    request: {
      kind: "doi",
      sourceType: "peer_reviewed_publication",
      identifier: "10.1109/TSE.2025.3489012",
      documentUrl: "https://example.org/paper.pdf",
    },
  };
}

describe("startSourceCaptureItem", () => {
  it("captures the source, stamps the work-item id, and reports ok", async () => {
    const runner = createJobRunner();
    const fetcher = fakeFetcher({
      "https://doi.org/": {
        contentType: "application/vnd.citationstyles.csl+json",
        body: Buffer.from(CSL_JSON_RESPONSE),
      },
      "https://example.org/paper.pdf": {
        contentType: "application/pdf",
        body: PDF_BYTES,
      },
    });
    const handle = await startSourceCaptureItem(PROJECT_ID, doiItem("wi_ok"), {
      runner,
      fetcher,
    });
    const summary = await handle.done;
    expect(summary).toEqual({ succeeded: 1, failed: 0 });
    expect(handle.kind).toBe("source_capture");

    const register = await RegisterStore.forProject(PROJECT_ID).read();
    expect(register.sources).toHaveLength(1);
    expect(register.sources[0].custom.capture_attempt_id).toBe("wi_ok");
    // No failure event on success — the source entry IS the durable record.
    expect(
      register.project_events.filter(
        (event) => event.event === "source_capture_failed",
      ),
    ).toHaveLength(0);
    expect(getSourceCaptureRun(PROJECT_ID, { runner })?.runId).toBe(
      handle.runId,
    );
  });

  it("records the durable failure and an error outcome when capture throws", async () => {
    const runner = createJobRunner();
    // No routes: the DOI resolution 404s, the capture throws.
    const fetcher = fakeFetcher({});
    const handle = await startSourceCaptureItem(
      PROJECT_ID,
      doiItem("wi_fail"),
      { runner, fetcher },
    );
    const summary = await handle.done;
    expect(summary).toEqual({ succeeded: 0, failed: 1 });
    const outcome = handle
      .eventsSoFar()
      .find((event) => event.type === "item_completed");
    expect(outcome && "outcome" in outcome && outcome.outcome.status).toBe(
      "error",
    );

    const register = await RegisterStore.forProject(PROJECT_ID).read();
    expect(register.sources).toHaveLength(0);
    const failure = register.project_events.at(-1);
    expect(failure?.event).toBe("source_capture_failed");
    expect(failure?.capture_failure).toMatchObject({
      work_item_id: "wi_fail",
      origin: "manual",
      input: { kind: "doi", identifier: "10.1109/TSE.2025.3489012" },
    });
  });
});

describe("startSourceCaptureItem with a correction item", () => {
  async function addWrongSource(): Promise<string> {
    const { captureSource } = await import("../capture");
    const source = await captureSource(
      {
        projectId: PROJECT_ID,
        kind: "upload",
        sourceType: "grey_literature",
        manual: { title: "Falsches Paper" },
        upload: { content: Buffer.from("Falscher Text."), filename: "f.txt" },
      },
      { fetcher: fakeFetcher({}) },
    );
    return source.id;
  }

  function correctionItem(
    workItemId: string,
    targetSourceId: string,
  ): SourceCaptureWorkItem {
    return {
      workItemId,
      origin: "correction",
      label: "10.1109/TSE.2025.3489012",
      request: {
        kind: "doi",
        sourceType: "grey_literature",
        targetSourceId,
        identifier: "10.1109/TSE.2025.3489012",
        documentUrl: "https://example.org/paper.pdf",
      },
    };
  }

  it("corrects the target instead of creating a source", async () => {
    const targetId = await addWrongSource();
    const runner = createJobRunner();
    const fetcher = fakeFetcher({
      "https://doi.org/": {
        contentType: "application/vnd.citationstyles.csl+json",
        body: Buffer.from(CSL_JSON_RESPONSE),
      },
      "https://example.org/paper.pdf": {
        contentType: "application/pdf",
        body: PDF_BYTES,
      },
    });
    const handle = await startSourceCaptureItem(
      PROJECT_ID,
      correctionItem("wi_korrektur", targetId),
      { runner, fetcher },
    );
    expect(await handle.done).toEqual({ succeeded: 1, failed: 0 });

    const register = await RegisterStore.forProject(PROJECT_ID).read();
    expect(register.sources).toHaveLength(1);
    const source = register.sources[0];
    expect(source.id).toBe(targetId);
    expect(source.DOI).toBe("10.1109/TSE.2025.3489012");
    expect(source.custom.correction_attempt_id).toBe("wi_korrektur");
    expect(source.custom.previous_identities).toHaveLength(1);
    expect(
      register.project_events.filter(
        (event) => event.event === "source_identity_corrected",
      ),
    ).toHaveLength(1);
  });

  it("corrects via a frozen upload, rebuilding the bytes from the blob store", async () => {
    const targetId = await addWrongSource();
    const store = RegisterStore.forProject(PROJECT_ID);
    const content = Buffer.from("Der richtige Volltext.");
    const blob = store.blobs().put(content, "txt");
    const runner = createJobRunner();
    const handle = await startSourceCaptureItem(
      PROJECT_ID,
      {
        workItemId: "wi_upload_korrektur",
        origin: "correction",
        label: "Richtig",
        request: {
          kind: "upload",
          sourceType: "grey_literature",
          targetSourceId: targetId,
          manual: { title: "Richtiges Paper", year: "2026" },
          uploadBlob: { blob_path: blob.blobPath, filename: "richtig.txt" },
        },
      },
      { runner, fetcher: fakeFetcher({}) },
    );
    expect(await handle.done).toEqual({ succeeded: 1, failed: 0 });
    const register = await store.read();
    const source = register.sources[0];
    expect(source.id).toBe(targetId);
    expect(source.title).toBe("Richtiges Paper");
    expect(
      store.blobs().read(source.custom.snapshot?.blob_path as string),
    ).toEqual(content);
  });

  it("records a correction failure carrying the target source id", async () => {
    const targetId = await addWrongSource();
    const runner = createJobRunner();
    const handle = await startSourceCaptureItem(
      PROJECT_ID,
      correctionItem("wi_korrektur_fail", targetId),
      { runner, fetcher: fakeFetcher({}) },
    );
    expect(await handle.done).toEqual({ succeeded: 0, failed: 1 });

    const register = await RegisterStore.forProject(PROJECT_ID).read();
    // The target source is untouched by the failed attempt.
    expect(register.sources[0].title).toBe("Falsches Paper");
    const failure = register.project_events.at(-1);
    expect(failure?.event).toBe("source_capture_failed");
    expect(failure?.capture_failure).toMatchObject({
      work_item_id: "wi_korrektur_fail",
      origin: "correction",
      input: { kind: "doi", target_source_id: targetId },
    });
  });
});

describe("toCaptureSourceInput", () => {
  it("reads a frozen upload's bytes back from the blob store", () => {
    const store = RegisterStore.forProject(PROJECT_ID);
    const blob = store.blobs().put(PDF_BYTES, "pdf");
    const input = toCaptureSourceInput(PROJECT_ID, "wi_blob", {
      kind: "upload",
      sourceType: "grey_literature",
      manual: { title: "Bericht" },
      uploadBlob: { blob_path: blob.blobPath, filename: "bericht.pdf" },
    });
    expect(input.captureAttemptId).toBe("wi_blob");
    expect(input.upload?.filename).toBe("bericht.pdf");
    expect(input.upload?.content.equals(PDF_BYTES)).toBe(true);
  });

  it("passes scalar fields through and omits absent ones", () => {
    const input = toCaptureSourceInput(PROJECT_ID, "wi_plain", {
      kind: "arxiv",
      sourceType: "preprint",
      identifier: "2401.12345",
      expectedExt: "pdf",
    });
    expect(input).toEqual({
      projectId: PROJECT_ID,
      kind: "arxiv",
      sourceType: "preprint",
      captureAttemptId: "wi_plain",
      identifier: "2401.12345",
      expectedExt: "pdf",
    });
  });

  it("carries a repair attempt's auto-capture provenance through", () => {
    const input = toCaptureSourceInput(PROJECT_ID, "wi_auto", {
      kind: "doi",
      sourceType: "peer_reviewed_publication",
      identifier: "10.1109/TSE.2025.3489012",
      autoCapture: {
        raw_text: "Meyer 2025",
        method: "crossref_title",
        score: 0.9,
      },
    });
    expect(input.autoCapture).toEqual({
      raw_text: "Meyer 2025",
      method: "crossref_title",
      score: 0.9,
    });
  });
});
