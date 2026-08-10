import { describe, expect, it } from "vitest";

import type { Source } from "../../../register";
import { CONFIDENT_THRESHOLD } from "./crossref-match";
import { buildCandidateReview } from "./review";
import type { ReferenceCandidate, ReferenceScanResult } from "./schema";

function candidate(overrides: Partial<ReferenceCandidate>): ReferenceCandidate {
  return {
    candidate_id: "cnd_0000000000000000",
    raw_text: "raw",
    method: "doi",
    suggested_source_type: "peer_reviewed_publication",
    ...overrides,
  };
}

function scanResult(candidates: ReferenceCandidate[]): ReferenceScanResult {
  return { scanned_at: "2026-08-09T00:00:00Z", method: "regex", candidates };
}

function source(overrides: Record<string, unknown>): Source {
  return {
    id: "src_x",
    type: "article",
    custom: { source_type: "peer_reviewed_publication" },
    ...overrides,
  } as Source;
}

describe("buildCandidateReview", () => {
  it("a doi candidate not yet captured: not captured, capturable, selected", () => {
    const [review] = buildCandidateReview(
      scanResult([candidate({ method: "doi", doi: "10.1000/xyz" })]),
      [],
    );
    expect(review).toMatchObject({
      alreadyCaptured: false,
      capturable: true,
      selected: true,
    });
  });

  it("a doi candidate whose DOI matches a captured source: alreadyCaptured with the source id", () => {
    const [review] = buildCandidateReview(
      scanResult([candidate({ method: "doi", doi: "10.1000/xyz" })]),
      [source({ id: "src_meyer2025", DOI: "10.1000/xyz" })],
    );
    expect(review.alreadyCaptured).toBe(true);
    expect(review.capturedAsSourceId).toBe("src_meyer2025");
  });

  it("a candidate matched by auto_capture raw_text+method (no identifier of its own): alreadyCaptured", () => {
    const [review] = buildCandidateReview(
      scanResult([
        candidate({
          method: "crossref_title",
          raw_text: "Meyer et al. (2025)",
          doi: "10.1000/xyz",
        }),
      ]),
      [
        source({
          id: "src_meyer2025",
          custom: {
            source_type: "peer_reviewed_publication",
            auto_capture: {
              raw_text: "Meyer et al. (2025)",
              method: "crossref_title",
            },
          },
        }),
      ],
    );
    expect(review.alreadyCaptured).toBe(true);
  });

  it("an unresolved candidate is never capturable or selected", () => {
    const [review] = buildCandidateReview(
      scanResult([
        candidate({ method: "unresolved", raw_text: "unklare Referenz" }),
      ]),
      [],
    );
    expect(review.capturable).toBe(false);
    expect(review.selected).toBe(false);
  });

  it("a url candidate WITH a title is capturable", () => {
    const [review] = buildCandidateReview(
      scanResult([
        candidate({ method: "url", url: "https://x.org", title: "Ein Titel" }),
      ]),
      [],
    );
    expect(review.capturable).toBe(true);
  });

  it("a url candidate WITHOUT a title is not capturable", () => {
    const [review] = buildCandidateReview(
      scanResult([candidate({ method: "url", url: "https://x.org" })]),
      [],
    );
    expect(review.capturable).toBe(false);
    expect(review.selected).toBe(false);
  });

  it("a crossref_title match at/above CONFIDENT_THRESHOLD is pre-selected", () => {
    const [review] = buildCandidateReview(
      scanResult([
        candidate({
          method: "crossref_title",
          doi: "10.1000/xyz",
          match_score: CONFIDENT_THRESHOLD,
        }),
      ]),
      [],
    );
    expect(review.capturable).toBe(true);
    expect(review.selected).toBe(true);
  });

  it("a crossref_title match below CONFIDENT_THRESHOLD is capturable but not pre-selected", () => {
    const [review] = buildCandidateReview(
      scanResult([
        candidate({
          method: "crossref_title",
          doi: "10.1000/xyz",
          match_score: CONFIDENT_THRESHOLD - 0.1,
        }),
      ]),
      [],
    );
    expect(review.capturable).toBe(true);
    expect(review.selected).toBe(false);
  });

  it("an arxiv candidate matched by arxiv-URL identifier equality: alreadyCaptured", () => {
    const [review] = buildCandidateReview(
      scanResult([
        candidate({
          method: "arxiv",
          arxiv_id: "2401.12345",
          raw_text: "arXiv:2401.12345",
        }),
      ]),
      [source({ id: "src_x2024", URL: "https://arxiv.org/abs/2401.12345" })],
    );
    expect(review.alreadyCaptured).toBe(true);
    expect(review.capturedAsSourceId).toBe("src_x2024");
  });
});
