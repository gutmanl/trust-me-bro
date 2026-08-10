import { describe, expect, it } from "vitest";

import type { CrossrefWork } from "./crossref";
import {
  CONFIDENT_THRESHOLD,
  MATCH_FLOOR,
  scoreMatch,
  titleSimilarity,
} from "./crossref-match";

describe("titleSimilarity", () => {
  it("is 1 for identical titles", () => {
    expect(
      titleSimilarity(
        "Effects of AI on Code Review",
        "Effects of AI on Code Review",
      ),
    ).toBe(1);
  });

  it("is 0 for completely different titles", () => {
    expect(
      titleSimilarity(
        "Effects of AI on Code Review",
        "Zebra Migration Patterns",
      ),
    ).toBeLessThan(0.2);
  });

  it("is order/case/punctuation tolerant to a meaningful degree", () => {
    const score = titleSimilarity(
      "Effects of AI Assistants on Code Review Duration",
      "EFFECTS OF AI ASSISTANTS ON CODE-REVIEW DURATION!",
    );
    expect(score).toBeGreaterThan(0.9);
  });

  it("is 0 when either title is empty", () => {
    expect(titleSimilarity("", "Something")).toBe(0);
    expect(titleSimilarity("Something", "")).toBe(0);
  });
});

const WORK: CrossrefWork = {
  doi: "10.1109/TSE.2025.3489012",
  title: "Effects of AI Assistants on Code Review Duration",
  authors: ["Meyer"],
  year: 2025,
  venue: "IEEE Transactions on Software Engineering",
};

describe("scoreMatch", () => {
  it("scores a perfect match at 1", () => {
    const score = scoreMatch(
      { title: WORK.title!, year: 2025, authors: ["Anna Meyer"] },
      WORK,
    );
    expect(score).toBeCloseTo(1, 5);
  });

  it("gives half year credit for a one-year difference", () => {
    const exact = scoreMatch(
      { title: WORK.title!, year: 2025, authors: ["Anna Meyer"] },
      WORK,
    );
    const offByOne = scoreMatch(
      { title: WORK.title!, year: 2026, authors: ["Anna Meyer"] },
      WORK,
    );
    expect(exact - offByOne).toBeCloseTo(0.25 * 0.5, 5);
  });

  it("gives no year credit for a two-year difference", () => {
    const score = scoreMatch(
      { title: WORK.title!, year: 2023, authors: ["Anna Meyer"] },
      WORK,
    );
    expect(score).toBeCloseTo(0.6 * 1 + 0.15 * 1, 5);
  });

  it("gives no year credit when either year is unknown", () => {
    const score = scoreMatch(
      { title: WORK.title!, authors: ["Anna Meyer"] },
      WORK,
    );
    expect(score).toBeCloseTo(0.6 * 1 + 0.15 * 1, 5);
  });

  it("gives author credit only for a matching first-author family name", () => {
    const match = scoreMatch(
      { title: "x", year: 2025, authors: ["Anna Meyer"] },
      {
        ...WORK,
        title: "x",
      },
    );
    const mismatch = scoreMatch(
      { title: "x", year: 2025, authors: ["Ben Schulz"] },
      {
        ...WORK,
        title: "x",
      },
    );
    expect(match - mismatch).toBeCloseTo(0.15, 5);
  });

  it("scores an unrelated title/author/year below the match floor", () => {
    const score = scoreMatch(
      {
        title: "Zebra Migration Patterns",
        year: 1990,
        authors: ["Someone Else"],
      },
      WORK,
    );
    expect(score).toBeLessThan(MATCH_FLOOR);
  });

  it("CONFIDENT_THRESHOLD sits above MATCH_FLOOR", () => {
    expect(CONFIDENT_THRESHOLD).toBeGreaterThan(MATCH_FLOOR);
  });
});
