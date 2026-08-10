import { describe, expect, it } from "vitest";

import { formatModel } from "../app/projects/status-labels";

/**
 * S-11: the adapter layer records the English sentinel "unknown" when a
 * backend could not determine which model served a request. The display tier
 * has to name that gap in German rather than leaking the raw token, and must
 * leave every real model name untouched — it is provenance, not copy.
 */
describe("formatModel", () => {
  it("names an unresolved model in German", () => {
    expect(formatModel("unknown")).toBe("Modell nicht ermittelt");
  });

  it("passes real model names through verbatim", () => {
    for (const model of [
      "claude-sonnet-4-5-20250929",
      "gpt-5-codex",
      "mock-1",
    ]) {
      expect(formatModel(model)).toBe(model);
    }
  });

  it("does not treat a model whose name merely contains the sentinel as unresolved", () => {
    expect(formatModel("unknown-model-v2")).toBe("unknown-model-v2");
  });
});
