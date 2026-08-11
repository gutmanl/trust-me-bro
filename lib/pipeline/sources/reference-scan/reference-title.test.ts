import { describe, expect, it } from "vitest";

import { cleanReferenceTitle } from "./reference-title";

describe("cleanReferenceTitle", () => {
  it("strips a trailing | site/venue suffix", () => {
    expect(
      cleanReferenceTitle(
        "A Study on the Comprehensibility of Behavioral Programming Variants | OpenReview.",
      ),
    ).toBe(
      "A Study on the Comprehensibility of Behavioral Programming Variants",
    );
  });

  it("strips an Elicit-style ellipsis truncation", () => {
    expect(
      cleanReferenceTitle(
        "On Visualization and Comprehension of Scenario-Based ...",
      ),
    ).toBe("On Visualization and Comprehension of Scenario-Based");
    expect(cleanReferenceTitle("A very long title …")).toBe(
      "A very long title",
    );
  });

  it("strips surrounding quotes and trailing punctuation", () => {
    expect(cleanReferenceTitle('"Some Paper Title".')).toBe("Some Paper Title");
    expect(cleanReferenceTitle("„Ein Titel“")).toBe("Ein Titel");
  });

  it("leaves an already-clean title untouched", () => {
    expect(cleanReferenceTitle("Attention Is All You Need")).toBe(
      "Attention Is All You Need",
    );
  });

  it("does not eat an internal pipe when there is no short trailing venue", () => {
    // Only the LAST ' | ' segment is dropped; a title that legitimately ends
    // without one is unaffected.
    expect(cleanReferenceTitle("Design | Build | Test in Practice")).toBe(
      "Design | Build",
    );
  });
});
