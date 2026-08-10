import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../../register";
import { PipelineError } from "../../errors";
import { createProject } from "../../projects";
import { getReferenceCandidates } from "./read-candidates";
import { ReferenceScanResult } from "./schema";
import type { ReferenceCandidate } from "./schema";

const PROJECT_ID = "proj_referenzlesen";

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-refread-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT_ID,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const CANDIDATE: ReferenceCandidate = {
  candidate_id: "cnd_x",
  raw_text: "line",
  method: "doi",
  doi: "10.1000/xyz",
  suggested_source_type: "peer_reviewed_publication",
};

describe("getReferenceCandidates", () => {
  it("returns an empty list before any scan", async () => {
    await expect(getReferenceCandidates(PROJECT_ID)).resolves.toEqual([]);
  });

  it("projects the current scan result through buildCandidateReview", async () => {
    const store = RegisterStore.forProject(PROJECT_ID);
    const result = ReferenceScanResult.parse({
      scanned_at: new Date().toISOString(),
      method: "regex",
      candidates: [CANDIDATE],
    });
    await store.transaction((tx) => {
      const blob = store.blobs().put(JSON.stringify(result, null, 2), "json");
      tx.recordReferenceScan({
        sha256: blob.sha256,
        blob_path: blob.blobPath,
        method: "regex",
        candidate_count: 1,
        actor: "system:reference_scan",
        reason: "Test-Scan.",
      });
    });

    const review = await getReferenceCandidates(PROJECT_ID);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({
      candidate_id: "cnd_x",
      alreadyCaptured: false,
      capturable: true,
      selected: true,
    });
  });

  it("raises a PipelineError with a German message for a corrupt blob", async () => {
    const store = RegisterStore.forProject(PROJECT_ID);
    await store.transaction((tx) => {
      const blob = store.blobs().put("not valid json", "json");
      tx.recordReferenceScan({
        sha256: blob.sha256,
        blob_path: blob.blobPath,
        method: "regex",
        candidate_count: 0,
        actor: "system:reference_scan",
        reason: "Test-Scan.",
      });
    });

    await expect(getReferenceCandidates(PROJECT_ID)).rejects.toBeInstanceOf(
      PipelineError,
    );
    await expect(getReferenceCandidates(PROJECT_ID)).rejects.toThrow(
      /beschädigt/,
    );
  });
});
