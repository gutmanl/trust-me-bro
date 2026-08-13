import { describe, expect, it } from "vitest";

import {
  isCaveatParagraph,
  splitReasoningParagraphs,
} from "./reasoning-paragraphs";

describe("splitReasoningParagraphs", () => {
  it("keeps a single paragraph whole (old prompts)", () => {
    expect(
      splitReasoningParagraphs("Der Auszug nennt die Kennzahl wörtlich."),
    ).toEqual(["Der Auszug nennt die Kennzahl wörtlich."]);
  });

  it("splits on blank lines and trims", () => {
    expect(
      splitReasoningParagraphs(
        "Der Auszug stützt die Aussage.\n\nJedoch: nur für n = 120.",
      ),
    ).toEqual(["Der Auszug stützt die Aussage.", "Jedoch: nur für n = 120."]);
  });

  it("collapses extra blank lines and drops empty fragments", () => {
    expect(splitReasoningParagraphs("Eins.\n\n\n\nZwei.\n\n")).toEqual([
      "Eins.",
      "Zwei.",
    ]);
  });
});

describe("isCaveatParagraph", () => {
  it("recognizes only the literal Jedoch: prefix", () => {
    expect(isCaveatParagraph("Jedoch: nur eine Quelle.")).toBe(true);
    expect(isCaveatParagraph("Es gilt jedoch etwas anderes.")).toBe(false);
  });
});
