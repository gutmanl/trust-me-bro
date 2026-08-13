import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../../register";
import { PipelineError } from "../../errors";
import { createProject } from "../../projects";
import type { SourceCaptureWorkItem } from "../work-items/types";
import {
  buildAutoCaptureItems,
  enqueueCandidateCapture,
  enqueueReadyCandidateCaptures,
} from "./enqueue-candidate-capture";
import type { ReviewCandidate } from "./review";

const PROJECT_ID = "proj_candidate-enqueue";
const PDF_BYTES = Buffer.from("%PDF-1.7 fake");

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-cand-enqueue-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT_ID,
    research_question: "Werden Kandidaten sauber eingereiht?",
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

function reviewCandidate(
  overrides: Partial<ReviewCandidate> &
    Pick<ReviewCandidate, "candidate_id" | "method">,
): ReviewCandidate {
  return {
    raw_text: "Siehe Quelle.",
    suggested_source_type: "peer_reviewed_publication",
    alreadyCaptured: false,
    capturable: true,
    selected: true,
    ...overrides,
  } as ReviewCandidate;
}

const DOI_CANDIDATE = reviewCandidate({
  candidate_id: "cnd_doi",
  method: "doi",
  doi: "10.1109/TSE.2025.3489012",
  raw_text: "Siehe 10.1109/TSE.2025.3489012.",
  document_url: "https://publisher.example.org/derived.pdf",
});

function fakeChain(): { enqueued: SourceCaptureWorkItem[] } & {
  enqueueSourceCapture: (
    projectId: string,
    item: SourceCaptureWorkItem,
  ) => void;
} {
  const enqueued: SourceCaptureWorkItem[] = [];
  return {
    enqueued,
    enqueueSourceCapture(_projectId, item) {
      enqueued.push(item);
    },
  };
}

const candidatesReader = (candidates: ReviewCandidate[]) =>
  vi.fn(async () => candidates);

describe("enqueueCandidateCapture", () => {
  it("rejects a candidate no longer in the current scan result", async () => {
    await expect(
      enqueueCandidateCapture(
        PROJECT_ID,
        { candidateId: "cnd_gone", sourceType: "preprint" },
        { chain: fakeChain(), getReferenceCandidates: candidatesReader([]) },
      ),
    ).rejects.toThrow(/nicht mehr vorhanden/);
  });

  it("rejects an already-captured candidate", async () => {
    await expect(
      enqueueCandidateCapture(
        PROJECT_ID,
        { candidateId: "cnd_doi", sourceType: "preprint" },
        {
          chain: fakeChain(),
          getReferenceCandidates: candidatesReader([
            reviewCandidate({
              candidate_id: "cnd_doi",
              method: "doi",
              alreadyCaptured: true,
            }),
          ]),
        },
      ),
    ).rejects.toThrow(/bereits als Quelle erfasst/);
  });

  it("rejects an incomplete completion synchronously (unresolved without document)", async () => {
    await expect(
      enqueueCandidateCapture(
        PROJECT_ID,
        {
          candidateId: "cnd_unresolved",
          sourceType: "grey_literature",
          title: "Titel da, Dokument fehlt",
        },
        {
          chain: fakeChain(),
          getReferenceCandidates: candidatesReader([
            reviewCandidate({
              candidate_id: "cnd_unresolved",
              method: "unresolved",
            }),
          ]),
        },
      ),
    ).rejects.toThrow(PipelineError);
  });

  it("queues a doi candidate under its candidate id, derived URL guarded by expectedExt", async () => {
    const chain = fakeChain();
    const { workItemId } = await enqueueCandidateCapture(
      PROJECT_ID,
      { candidateId: "cnd_doi", sourceType: "peer_reviewed_publication" },
      { chain, getReferenceCandidates: candidatesReader([DOI_CANDIDATE]) },
    );
    expect(workItemId).toBe("cnd_doi");
    expect(chain.enqueued[0]).toMatchObject({
      workItemId: "cnd_doi",
      origin: "reference_import",
      request: {
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        documentUrl: "https://publisher.example.org/derived.pdf",
        // The app chose this link, so it must prove itself a PDF.
        expectedExt: "pdf",
        autoCapture: {
          raw_text: "Siehe 10.1109/TSE.2025.3489012.",
          method: "doi",
        },
      },
    });
  });

  it("lets a user-supplied document URL override the derived one, unguarded", async () => {
    const chain = fakeChain();
    await enqueueCandidateCapture(
      PROJECT_ID,
      {
        candidateId: "cnd_doi",
        sourceType: "peer_reviewed_publication",
        documentUrl: "https://user-override.example.org/paper.pdf",
      },
      { chain, getReferenceCandidates: candidatesReader([DOI_CANDIDATE]) },
    );
    const request = chain.enqueued[0].request;
    expect(request.documentUrl).toBe(
      "https://user-override.example.org/paper.pdf",
    );
    expect(request.expectedExt).toBeUndefined();
  });

  it("freezes an uploaded PDF as a blob and records unresolved provenance", async () => {
    const chain = fakeChain();
    await enqueueCandidateCapture(
      PROJECT_ID,
      {
        candidateId: "cnd_unresolved",
        sourceType: "grey_literature",
        title: "Unklare Referenz, vervollständigt",
        upload: { content: PDF_BYTES, filename: "paper.pdf" },
      },
      {
        chain,
        getReferenceCandidates: candidatesReader([
          reviewCandidate({
            candidate_id: "cnd_unresolved",
            method: "unresolved",
            raw_text: "Eine unklare Referenz.",
          }),
        ]),
      },
    );
    const request = chain.enqueued[0].request;
    expect(request.kind).toBe("upload");
    expect(request.autoCapture).toEqual({
      raw_text: "Eine unklare Referenz.",
      method: "unresolved",
    });
    expect(request.uploadBlob?.filename).toBe("paper.pdf");
    expect(JSON.stringify(request)).not.toContain("content");
    const store = RegisterStore.forProject(PROJECT_ID);
    expect(
      store
        .blobs()
        .read(request.uploadBlob?.blob_path ?? "")
        .equals(PDF_BYTES),
    ).toBe(true);
  });
});

describe("enqueueReadyCandidateCaptures / buildAutoCaptureItems", () => {
  const MIXED: ReviewCandidate[] = [
    DOI_CANDIDATE,
    // Below the confidence threshold → not selected.
    reviewCandidate({
      candidate_id: "cnd_fuzzy",
      method: "crossref_title",
      doi: "10.1/fuzzy",
      selected: false,
    }),
    // Needs a human completion.
    reviewCandidate({
      candidate_id: "cnd_unresolved",
      method: "unresolved",
      capturable: false,
      selected: false,
    }),
    // Already a source.
    reviewCandidate({
      candidate_id: "cnd_done",
      method: "doi",
      doi: "10.1/done",
      alreadyCaptured: true,
    }),
  ];

  it("queues exactly the pre-checked candidates with untouched defaults", async () => {
    const chain = fakeChain();
    const { queued } = await enqueueReadyCandidateCaptures(PROJECT_ID, {
      chain,
      getReferenceCandidates: candidatesReader(MIXED),
    });
    expect(queued).toBe(1);
    expect(chain.enqueued.map((item) => item.workItemId)).toEqual(["cnd_doi"]);
    // The form's own defaults: no title/url/upload override.
    expect(chain.enqueued[0].request.manual).toBeUndefined();
  });

  it("builds the same set as auto-capture items after a scan", async () => {
    const items = await buildAutoCaptureItems(PROJECT_ID, {
      getReferenceCandidates: candidatesReader(MIXED),
    });
    expect(items.map((item) => item.workItemId)).toEqual(["cnd_doi"]);
    expect(items[0].origin).toBe("reference_import");
  });

  it("returns nothing when no candidate qualifies", async () => {
    const items = await buildAutoCaptureItems(PROJECT_ID, {
      getReferenceCandidates: candidatesReader([]),
    });
    expect(items).toEqual([]);
  });
});
