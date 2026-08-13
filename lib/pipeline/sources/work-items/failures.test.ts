import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../../register";
import { DocumentFetchError } from "../../errors";
import { createProject } from "../../projects";
import {
  captureFailureInputOf,
  deriveOpenCaptureFailures,
  dismissCaptureFailure,
  recordCaptureFailure,
} from "./failures";
import type { SourceCaptureWorkItem } from "./types";

const PROJECT_ID = "proj_workitem-failures";

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-wi-failures-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT_ID,
    research_question: "Werden Fehlschläge dauerhaft?",
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

function manualItem(
  workItemId: string,
  overrides: Partial<SourceCaptureWorkItem["request"]> = {},
): SourceCaptureWorkItem {
  return {
    workItemId,
    origin: "manual",
    label: "Testquelle",
    request: {
      kind: "doi",
      sourceType: "peer_reviewed_publication",
      identifier: "10.1000/demo.1",
      ...overrides,
    },
  };
}

describe("captureFailureInputOf", () => {
  it("snapshots every retryable field and never any bytes", () => {
    const input = captureFailureInputOf({
      kind: "upload",
      sourceType: "grey_literature",
      manual: { title: "Bericht", authors: "Meyer, A.", year: "2026" },
      uploadBlob: {
        blob_path: `blobs/ab/${"ab".repeat(32)}.pdf`,
        filename: "bericht.pdf",
      },
    });
    expect(input).toEqual({
      kind: "upload",
      source_type: "grey_literature",
      manual: { title: "Bericht", authors: "Meyer, A.", year: "2026" },
      upload: {
        blob_path: `blobs/ab/${"ab".repeat(32)}.pdf`,
        filename: "bericht.pdf",
      },
    });
    expect(JSON.stringify(input)).not.toContain("content");
  });

  it("omits absent optionals instead of writing undefined", () => {
    const input = captureFailureInputOf({
      kind: "doi",
      sourceType: "preprint",
      identifier: "10.1/x",
    });
    expect(Object.keys(input).sort()).toEqual([
      "identifier",
      "kind",
      "source_type",
    ]);
  });
});

describe("recordCaptureFailure", () => {
  it("keeps a PipelineError's German message verbatim as the reason", async () => {
    await recordCaptureFailure(
      PROJECT_ID,
      manualItem("wi_pipe"),
      new DocumentFetchError("Dokument nicht abrufbar (HTTP 404)."),
    );
    const register = await RegisterStore.forProject(PROJECT_ID).read();
    const event = register.project_events.at(-1);
    expect(event?.event).toBe("source_capture_failed");
    expect(event?.actor).toBe("system:capture");
    expect(event?.reason).toBe("Dokument nicht abrufbar (HTTP 404).");
    expect(event?.capture_failure?.work_item_id).toBe("wi_pipe");
  });

  it("wraps a non-pipeline error in German prose", async () => {
    await recordCaptureFailure(
      PROJECT_ID,
      manualItem("wi_raw"),
      new Error("ECONNRESET"),
    );
    const register = await RegisterStore.forProject(PROJECT_ID).read();
    expect(register.project_events.at(-1)?.reason).toBe(
      "Erfassung fehlgeschlagen: ECONNRESET",
    );
  });
});

describe("deriveOpenCaptureFailures", () => {
  it("keeps only the latest failure per work item", async () => {
    await recordCaptureFailure(
      PROJECT_ID,
      manualItem("wi_twice"),
      new DocumentFetchError("Erster Fehler."),
    );
    await recordCaptureFailure(
      PROJECT_ID,
      manualItem("wi_twice"),
      new DocumentFetchError("Zweiter Fehler."),
    );
    const register = await RegisterStore.forProject(PROJECT_ID).read();
    const open = deriveOpenCaptureFailures(register);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      workItemId: "wi_twice",
      reason: "Zweiter Fehler.",
      origin: "manual",
    });
    expect(open[0].input.identifier).toBe("10.1000/demo.1");
  });

  it("treats a failure as resolved once a source claims its work item id", async () => {
    await recordCaptureFailure(
      PROJECT_ID,
      manualItem("wi_resolved"),
      new DocumentFetchError("Vorübergehend nicht abrufbar."),
    );
    const store = RegisterStore.forProject(PROJECT_ID);
    await store.transaction((tx) => {
      tx.addSource({
        id: "src_resolved",
        type: "article-journal",
        custom: {
          source_type: "preprint",
          capture_attempt_id: "wi_resolved",
        },
      });
    });
    const register = await store.read();
    expect(deriveOpenCaptureFailures(register)).toEqual([]);
  });

  it("returns an empty list for a register without failures", async () => {
    const register = await RegisterStore.forProject(PROJECT_ID).read();
    expect(deriveOpenCaptureFailures(register)).toEqual([]);
  });
});

describe("dismissCaptureFailure", () => {
  it("rejects a work item without an open failure", async () => {
    await expect(
      dismissCaptureFailure(PROJECT_ID, "wi_unknown"),
    ).rejects.toThrow(/kein offener Fehlschlag/);
  });

  it("hides the failure via a human-attributed event, chain intact", async () => {
    await recordCaptureFailure(
      PROJECT_ID,
      manualItem("wi_dismissed"),
      new DocumentFetchError("Dauerhaft nicht abrufbar."),
    );
    await dismissCaptureFailure(PROJECT_ID, "wi_dismissed");

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    expect(deriveOpenCaptureFailures(register)).toEqual([]);
    const event = register.project_events.at(-1);
    expect(event).toMatchObject({
      event: "source_capture_dismissed",
      actor: "human:lg",
      work_item_id: "wi_dismissed",
    });
    expect(event?.reason).toContain("Dauerhaft nicht abrufbar.");
    // Nothing was erased: the failure event stays in the chain.
    expect(
      register.project_events.filter(
        (entry) => entry.event === "source_capture_failed",
      ),
    ).toHaveLength(1);
    expect((await store.verify()).ok).toBe(true);
  });

  it("a NEWER failure of the same work item reopens the entry", async () => {
    await recordCaptureFailure(
      PROJECT_ID,
      manualItem("wi_back"),
      new DocumentFetchError("Erster Fehler."),
    );
    await dismissCaptureFailure(PROJECT_ID, "wi_back");
    await recordCaptureFailure(
      PROJECT_ID,
      manualItem("wi_back"),
      new DocumentFetchError("Neuer Fehler nach Verwerfen."),
    );
    const register = await RegisterStore.forProject(PROJECT_ID).read();
    const open = deriveOpenCaptureFailures(register);
    expect(open).toHaveLength(1);
    expect(open[0].reason).toBe("Neuer Fehler nach Verwerfen.");
  });
});
