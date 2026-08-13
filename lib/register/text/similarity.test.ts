import { describe, expect, it } from "vitest";

import {
  FUZZY_REANCHOR_THRESHOLD,
  findFuzzyParagraph,
  quoteContainmentScore,
} from "./similarity";

describe("quoteContainmentScore", () => {
  it("scores an exact substring 1.0, across normalization", () => {
    expect(
      quoteContainmentScore(
        "Reviewzeit sank von 42 auf 19 Minuten",
        "Die Studie zeigt: die Review-\nzeit sank von 42 auf 19 Minuten.",
      ),
    ).toBe(1);
  });

  it("scores a lightly reworded quote high but below 1", () => {
    const score = quoteContainmentScore(
      "die mediane Reviewzeit sank von 42 auf 19 Minuten",
      "Im Ergebnis sank die mediane Review-Zeit von 42 auf etwa 19 Minuten.",
    );
    expect(score).toBeGreaterThan(FUZZY_REANCHOR_THRESHOLD);
    expect(score).toBeLessThan(1);
  });

  it("scores unrelated text low", () => {
    expect(
      quoteContainmentScore(
        "die mediane Reviewzeit sank deutlich",
        "Kapitel 7 behandelt Grenzfälle der Nutzung von Yaks im Hochgebirge.",
      ),
    ).toBeLessThan(0.5);
  });

  it("returns 0 for degenerate inputs", () => {
    expect(quoteContainmentScore("", "Absatztext")).toBe(0);
    expect(quoteContainmentScore("Zitat", "")).toBe(0);
  });
});

describe("findFuzzyParagraph", () => {
  const paragraphs = [
    "Einleitung ohne Bezug.",
    "Die mediane Review-Zeit sank von 42 auf 19 Minuten (n = 120).",
    "Fazit ohne Bezug.",
  ];

  it("finds the best-scoring paragraph above the threshold (0-based)", () => {
    expect(
      findFuzzyParagraph("die mediane Reviewzeit sank von 42 auf 19 Minuten", [
        ...paragraphs,
      ]),
    ).toBe(1);
  });

  it("returns null when nothing clears the threshold", () => {
    expect(
      findFuzzyParagraph("Yaks im Hochgebirge tragen schwere Lasten", [
        ...paragraphs,
      ]),
    ).toBeNull();
  });
});
