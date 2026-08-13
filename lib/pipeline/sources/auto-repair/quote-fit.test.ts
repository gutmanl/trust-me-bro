import { describe, expect, it } from "vitest";

import { evaluateQuoteFit } from "./quote-fit";

const EXCERPTS = [
  "die Reviewzeit sank von 42 auf 19 Minuten",
  "Stichprobe von 120 Pull-Requests",
];

describe("evaluateQuoteFit", () => {
  it("is confident when the candidate contains what the current text lacks", () => {
    const result = evaluateQuoteFit(
      "Die Reviewzeit sank von 42 auf 19 Minuten, gemessen an einer " +
        "Stichprobe von 120 Pull-Requests.",
      EXCERPTS,
      "Ein völlig anderes Paper über Yaks.",
    );
    expect(result).toEqual({
      candidateMatches: 2,
      currentMatches: 0,
      checkedExcerpts: 2,
      confident: true,
    });
  });

  it("is not confident on a tie", () => {
    const text = "die Reviewzeit sank von 42 auf 19 Minuten";
    const result = evaluateQuoteFit(text, [EXCERPTS[0]], text);
    expect(result.confident).toBe(false);
  });

  it("is not confident when nothing matches", () => {
    const result = evaluateQuoteFit("Anderes Thema.", EXCERPTS, undefined);
    expect(result.candidateMatches).toBe(0);
    expect(result.confident).toBe(false);
  });

  it("treats a missing current text as zero current matches", () => {
    const result = evaluateQuoteFit(
      "die Reviewzeit sank von 42 auf 19 Minuten",
      [EXCERPTS[0]],
      undefined,
    );
    expect(result).toMatchObject({
      candidateMatches: 1,
      currentMatches: 0,
      confident: true,
    });
  });
});
