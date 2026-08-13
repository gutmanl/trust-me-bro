import { describe, expect, it, vi } from "vitest";

import type { RunHandle } from "../../runs/types";
import type { ReviewCandidate } from "./review";
import type {
  ReferenceCaptureItemResult,
  ReferenceCaptureSelection,
} from "./run-reference-capture";
import {
  selectAutoCaptures,
  startAutoReferenceCapture,
} from "./run-auto-reference-capture";

/**
 * The automatic capture's two halves: the policy deciding what the machine
 * takes unattended, and the use-case deciding whether a run happens at all.
 * Both are exercised against review candidates only — how those candidates
 * come to be is buildCandidateReview's own tested business.
 */

function candidate(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    candidate_id: "cand_1",
    raw_text: "Doe, J. (2024). Eine Studie. https://doi.org/10.1000/x",
    method: "doi",
    doi: "10.1000/x",
    title: "Eine Studie",
    suggested_source_type: "peer_reviewed_publication",
    alreadyCaptured: false,
    capturable: true,
    selected: true,
    ...overrides,
  };
}

describe("selectAutoCaptures", () => {
  it("takes the pre-checked candidates with the form's own defaults", () => {
    expect(
      selectAutoCaptures([
        candidate({
          candidate_id: "cand_doi",
          suggested_source_type: "peer_reviewed_publication",
        }),
        candidate({
          candidate_id: "cand_arxiv",
          method: "arxiv",
          suggested_source_type: "preprint",
        }),
      ]),
    ).toEqual<ReferenceCaptureSelection[]>([
      {
        candidateId: "cand_doi",
        sourceType: "peer_reviewed_publication",
      },
      { candidateId: "cand_arxiv", sourceType: "preprint" },
    ]);
  });

  it("never overrides title, document url or document", () => {
    const [selection] = selectAutoCaptures([
      candidate({ title: "Eine Studie", document_url: "https://x/y.pdf" }),
    ]);
    // Deliberately absent: the capture falls back to the candidate's own
    // derived document_url, which acquireDocument then still has to PROVE is
    // a PDF (expectedExt). A title/url passed here would read as a value a
    // human vouched for and would silently disable that guard.
    expect(selection).toEqual({
      candidateId: "cand_1",
      sourceType: "peer_reviewed_publication",
    });
  });

  it("leaves everything the review form would leave unchecked", () => {
    expect(
      selectAutoCaptures([
        // Nothing resolved it — needs a human's PDF or URL.
        candidate({ candidate_id: "a", method: "unresolved", selected: false }),
        // A Crossref title match below the confidence threshold.
        candidate({
          candidate_id: "b",
          method: "crossref_title",
          match_score: 0.4,
          selected: false,
        }),
        // A URL citation without a title to caption the source with.
        candidate({
          candidate_id: "c",
          method: "url",
          capturable: false,
          selected: false,
        }),
      ]),
    ).toEqual([]);
  });

  it("skips candidates that are already sources", () => {
    expect(
      selectAutoCaptures([
        candidate({
          alreadyCaptured: true,
          capturedAsSourceId: "src_doe_2024",
        }),
      ]),
    ).toEqual([]);
  });
});

describe("startAutoReferenceCapture", () => {
  const handle = {
    runId: "run_1",
  } as unknown as RunHandle<ReferenceCaptureItemResult>;

  it("captures exactly the qualifying candidates", async () => {
    const startReferenceCapture = vi.fn().mockResolvedValue(handle);
    const getReferenceCandidates = vi
      .fn()
      .mockResolvedValue([
        candidate({ candidate_id: "take_me" }),
        candidate({ candidate_id: "leave_me", selected: false }),
      ]);

    const result = await startAutoReferenceCapture("proj_a", {
      getReferenceCandidates,
      startReferenceCapture,
    });

    expect(result).toBe(handle);
    expect(startReferenceCapture).toHaveBeenCalledWith(
      "proj_a",
      [
        {
          candidateId: "take_me",
          sourceType: "peer_reviewed_publication",
        },
      ],
      {},
    );
  });

  it("starts no run when nothing qualifies", async () => {
    const startReferenceCapture = vi.fn();
    const getReferenceCandidates = vi
      .fn()
      .mockResolvedValue([candidate({ selected: false })]);

    await expect(
      startAutoReferenceCapture("proj_a", {
        getReferenceCandidates,
        startReferenceCapture,
      }),
    ).resolves.toBeUndefined();
    // Not even as a zero-item run: startReferenceCapture would refuse an
    // empty selection with a precondition error, and "this briefing cites
    // nothing resolvable" is not an error.
    expect(startReferenceCapture).not.toHaveBeenCalled();
  });

  it("starts no run when no scan has happened yet", async () => {
    const startReferenceCapture = vi.fn();
    const getReferenceCandidates = vi.fn().mockResolvedValue([]);

    await expect(
      startAutoReferenceCapture("proj_a", {
        getReferenceCandidates,
        startReferenceCapture,
      }),
    ).resolves.toBeUndefined();
    expect(startReferenceCapture).not.toHaveBeenCalled();
  });
});
