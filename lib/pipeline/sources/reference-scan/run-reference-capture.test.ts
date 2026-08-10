import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../../register";
import { ReferenceCapturePreconditionError } from "../../errors";
import { createProject } from "../../projects";
import { createJobRunner } from "../../runs/job-runner";
import { captureSource, freezeSourceSet } from "../capture";
import {
  ARXIV_ATOM_RESPONSE,
  CSL_JSON_RESPONSE,
  fakeFetcher,
} from "../__fixtures__/fake-fetcher";
import type { HttpFetcher } from "../fetch-port";
import { startReferenceCapture } from "./run-reference-capture";
import { ReferenceScanResult } from "./schema";
import type { ReferenceCandidate } from "./schema";

const PROJECT_ID = "proj_referenzerfassung";
const PDF_BYTES = Buffer.from("%PDF-1.7 fake");

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-refcapture-"));
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
  fs.rmSync(workspace, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

async function writeScanResult(
  candidates: ReferenceCandidate[],
): Promise<void> {
  const store = RegisterStore.forProject(PROJECT_ID);
  const result = ReferenceScanResult.parse({
    scanned_at: new Date().toISOString(),
    method: "regex",
    candidates,
  });
  await store.transaction((tx) => {
    const blob = store.blobs().put(JSON.stringify(result, null, 2), "json");
    tx.recordReferenceScan({
      sha256: blob.sha256,
      blob_path: blob.blobPath,
      method: "regex",
      candidate_count: candidates.length,
      actor: "system:reference_scan",
      reason: "Test-Scan.",
    });
  });
}

function baseFetcher() {
  return fakeFetcher({
    "https://doi.org/": {
      contentType: "application/vnd.citationstyles.csl+json",
      body: Buffer.from(CSL_JSON_RESPONSE),
    },
    "https://export.arxiv.org/": {
      contentType: "application/atom+xml",
      body: Buffer.from(ARXIV_ATOM_RESPONSE),
    },
    "https://arxiv.org/pdf/": {
      contentType: "application/pdf",
      body: PDF_BYTES,
    },
    "https://blog.example.org/post-a": {
      contentType: "text/html",
      body: Buffer.from("<html><body>A</body></html>"),
    },
    "https://blog.example.org/post-b": {
      contentType: "text/html",
      body: Buffer.from("<html><body>B</body></html>"),
    },
  });
}

const DOI_CANDIDATE: ReferenceCandidate = {
  candidate_id: "cnd_doi",
  raw_text: "Siehe 10.1109/TSE.2025.3489012.",
  method: "doi",
  doi: "10.1109/TSE.2025.3489012",
  suggested_source_type: "peer_reviewed_publication",
};
const ARXIV_CANDIDATE: ReferenceCandidate = {
  candidate_id: "cnd_arxiv",
  raw_text: "arXiv:2401.12345 beschreibt das Verfahren.",
  method: "arxiv",
  arxiv_id: "2401.12345",
  suggested_source_type: "preprint",
};
const URL_TITLED_CANDIDATE: ReferenceCandidate = {
  candidate_id: "cnd_url_titled",
  raw_text: "https://blog.example.org/post-a wird erwähnt.",
  method: "url",
  url: "https://blog.example.org/post-a",
  title: "Ein Blogpost",
  suggested_source_type: "grey_literature",
};
const URL_UNTITLED_CANDIDATE: ReferenceCandidate = {
  candidate_id: "cnd_url_untitled",
  raw_text: "https://blog.example.org/post-b wird erwähnt.",
  method: "url",
  url: "https://blog.example.org/post-b",
  suggested_source_type: "grey_literature",
};
const UNRESOLVED_CANDIDATE: ReferenceCandidate = {
  candidate_id: "cnd_unresolved",
  raw_text: "Eine unklare Referenz.",
  method: "unresolved",
  suggested_source_type: "grey_literature",
};

describe("startReferenceCapture preconditions", () => {
  it("rejects an empty selection", async () => {
    await expect(startReferenceCapture(PROJECT_ID, [])).rejects.toBeInstanceOf(
      ReferenceCapturePreconditionError,
    );
  });

  it("rejects once the source set is frozen", async () => {
    await writeScanResult([ARXIV_CANDIDATE]);
    await captureSource(
      {
        projectId: PROJECT_ID,
        kind: "upload",
        sourceType: "grey_literature",
        manual: { title: "Bericht" },
        upload: { content: PDF_BYTES, filename: "a.pdf" },
      },
      { fetcher: fakeFetcher({}) },
    );
    await freezeSourceSet(PROJECT_ID);
    await expect(
      startReferenceCapture(PROJECT_ID, [
        { candidateId: "cnd_arxiv", sourceType: "preprint" },
      ]),
    ).rejects.toBeInstanceOf(ReferenceCapturePreconditionError);
  });
});

describe("startReferenceCapture: mixed success/failure batch", () => {
  it("continues past per-item failures (missing document URL, unresolved candidate)", async () => {
    await writeScanResult([
      DOI_CANDIDATE,
      ARXIV_CANDIDATE,
      URL_TITLED_CANDIDATE,
      UNRESOLVED_CANDIDATE,
    ]);
    const runner = createJobRunner();
    const handle = await startReferenceCapture(
      PROJECT_ID,
      [
        { candidateId: "cnd_doi", sourceType: "peer_reviewed_publication" },
        { candidateId: "cnd_arxiv", sourceType: "preprint" },
        { candidateId: "cnd_url_titled", sourceType: "grey_literature" },
        { candidateId: "cnd_unresolved", sourceType: "grey_literature" },
      ],
      { runner, fetcher: baseFetcher() },
    );
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 2, failed: 2 });

    const outcomes = handle
      .eventsSoFar()
      .filter((event) => event.type === "item_completed")
      .map((event) => (event.type === "item_completed" ? event.outcome : null));
    expect(outcomes.map((o) => o?.itemId)).toEqual([
      "cnd_doi",
      "cnd_arxiv",
      "cnd_url_titled",
      "cnd_unresolved",
    ]);
    expect(outcomes[0]?.status).toBe("error");
    expect(outcomes[1]?.status).toBe("ok");
    expect(outcomes[2]?.status).toBe("ok");
    expect(outcomes[3]?.status).toBe("error");

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    expect(register.sources).toHaveLength(2);
    expect(
      register.sources.map((s) => s.custom.auto_capture?.method).sort(),
    ).toEqual(["arxiv", "url"].sort());
    const arxivSource = register.sources.find(
      (s) => s.custom.auto_capture?.method === "arxiv",
    );
    expect(arxivSource?.custom.auto_capture?.raw_text).toBe(
      ARXIV_CANDIDATE.raw_text,
    );
    expect((await store.verify()).ok).toBe(true);
  });
});

describe("startReferenceCapture: url-method title handling", () => {
  it("uses the user-supplied title override for a url candidate lacking its own", async () => {
    await writeScanResult([URL_UNTITLED_CANDIDATE]);
    const handle = await startReferenceCapture(
      PROJECT_ID,
      [
        {
          candidateId: "cnd_url_untitled",
          sourceType: "grey_literature",
          title: "Manuell ergänzter Titel",
        },
      ],
      { runner: createJobRunner(), fetcher: baseFetcher() },
    );
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 1, failed: 0 });

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    expect(register.sources[0].title).toBe("Manuell ergänzter Titel");
    expect(register.sources[0].custom.auto_capture?.method).toBe("url");
  });

  it("fails per-item when a url candidate has neither its own title nor an override", async () => {
    await writeScanResult([URL_UNTITLED_CANDIDATE]);
    const handle = await startReferenceCapture(
      PROJECT_ID,
      [{ candidateId: "cnd_url_untitled", sourceType: "grey_literature" }],
      { runner: createJobRunner(), fetcher: baseFetcher() },
    );
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 0, failed: 1 });
    const outcome = handle
      .eventsSoFar()
      .find((event) => event.type === "item_completed");
    expect(outcome?.type).toBe("item_completed");
    if (outcome?.type === "item_completed") {
      expect(outcome.outcome.status).toBe("error");
      expect(outcome.outcome.error).toContain("benötigt einen Titel");
    }
  });
});

describe("startReferenceCapture: stale candidate id", () => {
  it("fails per-item for a candidate id no longer in the current scan result", async () => {
    await writeScanResult([ARXIV_CANDIDATE]);
    const handle = await startReferenceCapture(
      PROJECT_ID,
      [{ candidateId: "cnd_does_not_exist", sourceType: "preprint" }],
      { runner: createJobRunner(), fetcher: baseFetcher() },
    );
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 0, failed: 1 });
    const outcome = handle
      .eventsSoFar()
      .find((event) => event.type === "item_completed");
    if (outcome?.type === "item_completed") {
      expect(outcome.outcome.error).toContain("nicht mehr vorhanden");
    }
  });
});

describe("startReferenceCapture: corrupt scan blob", () => {
  it("fails the item with the shared German PipelineError message, never a raw parse error", async () => {
    const store = RegisterStore.forProject(PROJECT_ID);
    await store.transaction((tx) => {
      const blob = store.blobs().put("not valid json", "json");
      tx.recordReferenceScan({
        sha256: blob.sha256,
        blob_path: blob.blobPath,
        method: "regex",
        candidate_count: 0,
        actor: "system:reference_scan",
        reason: "Test-Scan (korrupt).",
      });
    });

    const handle = await startReferenceCapture(
      PROJECT_ID,
      [{ candidateId: "cnd_x", sourceType: "preprint" }],
      { runner: createJobRunner(), fetcher: baseFetcher() },
    );
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 0, failed: 1 });
    const outcome = handle
      .eventsSoFar()
      .find((event) => event.type === "item_completed");
    if (outcome?.type === "item_completed") {
      expect(outcome.outcome.status).toBe("error");
      expect(outcome.outcome.error).toContain("beschädigt");
      expect(outcome.outcome.error).not.toMatch(
        /Unexpected token|is not valid JSON|ZodError/i,
      );
    }
  });
});

describe("startReferenceCapture: freeze mid-batch", () => {
  it("fails the item reached after a freeze happened between items", async () => {
    await writeScanResult([ARXIV_CANDIDATE, URL_TITLED_CANDIDATE]);
    const inner = baseFetcher();
    const freezingFetcher: HttpFetcher & { calls: unknown[] } = {
      calls: inner.calls,
      async fetch(url, options) {
        if (url.startsWith("https://blog.example.org/post-a")) {
          // Simulates a concurrent freeze happening between this batch's
          // items — captureSource re-checks the freeze status fresh inside
          // its own transaction, so this item must fail even though the
          // batch already started.
          await freezeSourceSet(PROJECT_ID);
        }
        return inner.fetch(url, options);
      },
    };

    const handle = await startReferenceCapture(
      PROJECT_ID,
      [
        { candidateId: "cnd_arxiv", sourceType: "preprint" },
        { candidateId: "cnd_url_titled", sourceType: "grey_literature" },
      ],
      { runner: createJobRunner(), fetcher: freezingFetcher },
    );
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 1, failed: 1 });

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    expect(register.sources).toHaveLength(1);
    expect(register.sources[0].custom.auto_capture?.method).toBe("arxiv");

    const outcomes = handle
      .eventsSoFar()
      .filter((event) => event.type === "item_completed")
      .map((event) => (event.type === "item_completed" ? event.outcome : null));
    expect(outcomes[0]?.status).toBe("ok");
    expect(outcomes[1]?.status).toBe("error");
    expect(outcomes[1]?.error).toMatch(/eingefroren/);
  });
});
