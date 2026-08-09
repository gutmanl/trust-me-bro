import { describe, expect, it } from "vitest";

import { needsSecondOpinion } from "./second-opinion";

const config = { confidence_threshold: 0.8, on_relation_not_supports: true };

describe("needsSecondOpinion", () => {
  it("triggers on confidence below the threshold", () => {
    expect(
      needsSecondOpinion(
        { relation_type: "supports", confidence: 0.79 },
        config,
      ),
    ).toBe(true);
  });

  it("does not trigger on a confident supports", () => {
    expect(
      needsSecondOpinion(
        { relation_type: "supports", confidence: 0.8 },
        config,
      ),
    ).toBe(false);
  });

  it("triggers on a relation other than supports when enabled", () => {
    expect(
      needsSecondOpinion(
        { relation_type: "partially_supports", confidence: 0.99 },
        config,
      ),
    ).toBe(true);
  });

  it("ignores the relation when on_relation_not_supports is disabled", () => {
    expect(
      needsSecondOpinion(
        { relation_type: "contradicts", confidence: 0.9 },
        { ...config, on_relation_not_supports: false },
      ),
    ).toBe(false);
  });
});
