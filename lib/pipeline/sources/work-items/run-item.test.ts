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
});
