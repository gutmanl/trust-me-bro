import { describe, expect, it } from "vitest";

import {
  containsNormalized,
  normalizeForSearch,
  splitBriefingParagraphs,
} from "./normalize";

describe("normalizeForSearch", () => {
  it("lowercases, folds typography and collapses whitespace", () => {
    expect(normalizeForSearch("Die  „mediane“   Review–Zeit")).toBe(
      'die "mediane" review-zeit',
    );
  });

  it("removes line-break hyphenation", () => {
    expect(normalizeForSearch("Review-\nzeit sank")).toBe("reviewzeit sank");
    expect(normalizeForSearch("Review- \r\n zeit")).toBe("reviewzeit");
  });

  it("is idempotent", () => {
    const once = normalizeForSearch("„Review-\nzeit“ – 55 %");
    expect(normalizeForSearch(once)).toBe(once);
  });
});

describe("containsNormalized", () => {
  const haystack =
    "Die mediane Review-\nzeit sank von 42 auf 19 Minuten (minus 55 Prozent).";

  it("finds quotes across hyphenation and quote styles", () => {
    expect(containsNormalized(haystack, "Reviewzeit sank von 42")).toBe(true);
    expect(containsNormalized(haystack, "MEDIANE   Reviewzeit")).toBe(true);
  });

  it("rejects absent quotes and empty needles", () => {
    expect(containsNormalized(haystack, "Reviewzeit stieg")).toBe(false);
    expect(containsNormalized(haystack, "   ")).toBe(false);
  });
});

describe("splitBriefingParagraphs", () => {
  it("normalizes CRLF line endings before splitting", () => {
    expect(splitBriefingParagraphs("Absatz eins.\r\n\r\nAbsatz zwei.")).toEqual(
      ["Absatz eins.", "Absatz zwei."],
    );
  });

  it("treats runs of multiple blank lines as a single paragraph break", () => {
    expect(splitBriefingParagraphs("Absatz eins.\n\n\n\nAbsatz zwei.")).toEqual(
      ["Absatz eins.", "Absatz zwei."],
    );
  });

  it("returns an empty array for blank input", () => {
    expect(splitBriefingParagraphs("")).toEqual([]);
    expect(splitBriefingParagraphs("   \n\n  ")).toEqual([]);
  });
});
