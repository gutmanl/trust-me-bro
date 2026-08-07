import { describe, expect, it } from "vitest";

import { needsSecondOpinion } from "./second-opinion";

const config = { confidence_threshold: 0.8, on_relation_not_stuetzt: true };

describe("needsSecondOpinion", () => {
  it("triggers on confidence below the threshold", () => {
    expect(
      needsSecondOpinion(
        { relation_type: "stuetzt", confidence: 0.79 },
        config,
      ),
    ).toBe(true);
  });

  it("does not trigger on a confident stuetzt", () => {
    expect(
      needsSecondOpinion({ relation_type: "stuetzt", confidence: 0.8 }, config),
    ).toBe(false);
  });

  it("triggers on a relation other than stuetzt when enabled", () => {
    expect(
      needsSecondOpinion(
        { relation_type: "stuetzt_teilweise", confidence: 0.99 },
        config,
      ),
    ).toBe(true);
  });

  it("ignores the relation when on_relation_not_stuetzt is disabled", () => {
    expect(
      needsSecondOpinion(
        { relation_type: "widerspricht", confidence: 0.9 },
        { ...config, on_relation_not_stuetzt: false },
      ),
    ).toBe(false);
  });
});
