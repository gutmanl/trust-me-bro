import { describe, expect, it } from "vitest";

import type { Source } from "../../../register";
import {
  candidateId,
  excludeCaptured,
  mergeCandidates,
  suggestSourceType,
} from "./candidate";
import type { CandidateSeed } from "./candidate";

function source(overrides: Record<string, unknown>): Source {
  return {
    id: "src_x",
    type: "article",
    custom: { source_type: "peer_reviewed_publication" },
    ...overrides,
  } as Source;
}

describe("candidateId", () => {
  it("is stable across repeated calls for the same identity", () => {
    const seed: CandidateSeed = {
      raw_text: "line",
      method: "doi",
      doi: "10.1000/xyz123",
    };
    expect(candidateId(seed)).toBe(candidateId({ ...seed }));
  });

  it("is case-insensitive on the identifier", () => {
    const lower = candidateId({
      raw_text: "l",
      method: "doi",
      doi: "10.1000/xyz",
    });
    const upper = candidateId({
      raw_text: "l",
      method: "doi",
      doi: "10.1000/XYZ",
    });
    expect(lower).toBe(upper);
  });

  it("differs for different methods with the same raw_text", () => {
    const asDoi = candidateId({
      raw_text: "l",
      method: "doi",
      doi: "10.1000/x",
    });
    const asUnresolved = candidateId({ raw_text: "l", method: "unresolved" });
    expect(asDoi).not.toBe(asUnresolved);
  });

  it("falls back to raw_text when no identifier is present", () => {
    const a = candidateId({
      raw_text: "Meyer et al. (2025)",
      method: "unresolved",
    });
    const b = candidateId({
      raw_text: "Schulz et al. (2024)",
      method: "unresolved",
    });
    expect(a).not.toBe(b);
  });
});

describe("suggestSourceType", () => {
  it("maps arxiv to preprint", () => {
    expect(suggestSourceType("arxiv")).toBe("preprint");
  });
  it("maps doi and crossref_title to peer_reviewed_publication", () => {
    expect(suggestSourceType("doi")).toBe("peer_reviewed_publication");
    expect(suggestSourceType("crossref_title")).toBe(
      "peer_reviewed_publication",
    );
  });
  it("maps url and unresolved to grey_literature", () => {
    expect(suggestSourceType("url")).toBe("grey_literature");
    expect(suggestSourceType("unresolved")).toBe("grey_literature");
  });
});

describe("mergeCandidates", () => {
  it("keeps distinct identifiers as distinct candidates", () => {
    const result = mergeCandidates([
      { raw_text: "line 1", method: "doi", doi: "10.1000/aaa" },
      { raw_text: "line 2", method: "doi", doi: "10.1000/bbb" },
    ]);
    expect(result).toHaveLength(2);
  });

  it("collapses a regex DOI hit and an LLM-parsed citation of the same DOI", () => {
    const result = mergeCandidates([
      {
        raw_text: "Siehe 10.1109/TSE.2025.3489012.",
        method: "doi",
        doi: "10.1109/TSE.2025.3489012",
      },
      {
        raw_text: "Meyer et al. (2025) zeigen …",
        method: "doi",
        doi: "10.1109/TSE.2025.3489012",
        title: "Effects of AI Assistants on Code Review Duration",
        authors: ["Anna Meyer"],
        year: 2025,
      },
    ]);
    expect(result).toHaveLength(1);
    // Enriched with the LLM channel's metadata even though the regex hit's
    // raw_text/method won (first-seen identified method).
    expect(result[0]).toMatchObject({
      raw_text: "Siehe 10.1109/TSE.2025.3489012.",
      method: "doi",
      title: "Effects of AI Assistants on Code Review Duration",
      authors: ["Anna Meyer"],
      year: 2025,
    });
  });

  it("prefers an identified method (doi/arxiv/url) over crossref_title sharing the same DOI", () => {
    const result = mergeCandidates([
      {
        raw_text: "Fuzzy citation",
        method: "crossref_title",
        doi: "10.1109/TSE.2025.3489012",
        match_score: 0.8,
      },
      {
        raw_text: "Siehe 10.1109/TSE.2025.3489012.",
        method: "doi",
        doi: "10.1109/TSE.2025.3489012",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].method).toBe("doi");
    expect(result[0].raw_text).toBe("Siehe 10.1109/TSE.2025.3489012.");
    // I5 regression: the fuzzy title-match score must NOT survive onto the
    // doi winner — the DOI was found verbatim in the briefing, not guessed
    // by title similarity, so a score here would misrepresent it.
    expect(result[0].match_score).toBeUndefined();
  });

  it("keeps match_score when two crossref_title seeds resolve to the same DOI (I5)", () => {
    const result = mergeCandidates([
      {
        raw_text: "Fuzzy citation one",
        method: "crossref_title",
        doi: "10.1109/TSE.2025.3489012",
        match_score: 0.8,
      },
      {
        raw_text: "Fuzzy citation two",
        method: "crossref_title",
        doi: "10.1109/TSE.2025.3489012",
        match_score: 0.6,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].method).toBe("crossref_title");
    // The winning crossref_title candidate keeps ITS OWN score (first-seen),
    // never silently swapped for the other seed's.
    expect(result[0].match_score).toBe(0.8);
  });

  it("never merges unresolved candidates with each other", () => {
    const result = mergeCandidates([
      { raw_text: "Unklare Referenz eins.", method: "unresolved" },
      { raw_text: "Unklare Referenz zwei.", method: "unresolved" },
    ]);
    expect(result).toHaveLength(2);
  });

  it("sets suggested_source_type per the merged method", () => {
    const result = mergeCandidates([
      { raw_text: "arXiv:2401.12345", method: "arxiv", arxiv_id: "2401.12345" },
    ]);
    expect(result[0].suggested_source_type).toBe("preprint");
  });

  it("mints a candidate_id for every merged candidate", () => {
    const result = mergeCandidates([
      { raw_text: "line", method: "url", url: "https://example.org/x" },
    ]);
    expect(result[0].candidate_id).toMatch(/^cnd_[0-9a-f]{16}$/);
  });
});

describe("excludeCaptured", () => {
  const items: CandidateSeed[] = [
    {
      raw_text: "Siehe 10.1109/TSE.2025.3489012.",
      method: "doi",
      doi: "10.1109/TSE.2025.3489012",
    },
    {
      raw_text: "arXiv:2401.12345 beschreibt …",
      method: "arxiv",
      arxiv_id: "2401.12345",
    },
    {
      raw_text: "https://blog.example.org/post erwähnt …",
      method: "url",
      url: "https://blog.example.org/post",
    },
    { raw_text: "Meyer et al. (2025) zeigen …", method: "unresolved" },
  ];

  it("excludes a candidate whose DOI matches an already-captured source", () => {
    const sources = [source({ DOI: "10.1109/TSE.2025.3489012" })];
    const filtered = excludeCaptured(items, sources);
    expect(filtered.map((item) => item.raw_text)).not.toContain(
      items[0].raw_text,
    );
    expect(filtered).toHaveLength(3);
  });

  it("excludes a candidate whose arXiv id matches a captured source's arxiv.org URL", () => {
    const sources = [source({ URL: "https://arxiv.org/abs/2401.12345" })];
    const filtered = excludeCaptured(items, sources);
    expect(filtered.map((item) => item.raw_text)).not.toContain(
      items[1].raw_text,
    );
  });

  it("excludes a candidate whose URL matches a captured source's URL", () => {
    const sources = [source({ URL: "https://blog.example.org/post" })];
    const filtered = excludeCaptured(items, sources);
    expect(filtered.map((item) => item.raw_text)).not.toContain(
      items[2].raw_text,
    );
  });

  it("excludes an identifier-less candidate whose raw_text matches a source's auto_capture provenance", () => {
    const sources = [
      source({
        custom: {
          source_type: "peer_reviewed_publication",
          auto_capture: {
            raw_text: "Meyer et al. (2025) zeigen …",
            method: "crossref_title",
          },
        },
      }),
    ];
    const filtered = excludeCaptured(items, sources);
    expect(filtered.map((item) => item.raw_text)).not.toContain(
      items[3].raw_text,
    );
  });

  it("keeps every candidate when nothing is captured yet", () => {
    expect(excludeCaptured(items, [])).toHaveLength(items.length);
  });
});
