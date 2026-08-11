import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../../register";
import exampleProject from "../../register/schema/__fixtures__/example-project.json";
import { deriveSourceLifecycles } from "./source-lifecycle";

function register(): ClaimsRegister {
  return structuredClone(exampleProject) as unknown as ClaimsRegister;
}

describe("deriveSourceLifecycles", () => {
  it("reports revision, capture time and the claims resting on the source", () => {
    expect(deriveSourceLifecycles(register())).toEqual([
      {
        sourceId: "src_meyer2025",
        citingClaims: 1,
        revision: 1,
        capturedAt: "2026-07-28T08:05:12Z",
      },
    ]);
  });

  it("counts a claim once, however often it cites the same source", () => {
    const state = register();
    state.claims[0].evidence = [
      state.claims[0].evidence[0],
      { ...state.claims[0].evidence[0], id: "ev_0002" },
    ];
    expect(deriveSourceLifecycles(state)[0].citingClaims).toBe(1);
  });

  it("does not count discarded claims — nothing rests on them anymore", () => {
    const state = register();
    state.claims[0].status = "discarded";
    expect(deriveSourceLifecycles(state)[0].citingClaims).toBe(0);
  });

  it("reports a captured but uncited source with zero claims", () => {
    const state = register();
    state.claims = [];
    expect(deriveSourceLifecycles(state)).toHaveLength(1);
    expect(deriveSourceLifecycles(state)[0].citingClaims).toBe(0);
  });

  it("skips a source without a frozen snapshot", () => {
    const state = register();
    delete state.sources[0].custom.snapshot;
    expect(deriveSourceLifecycles(state)).toEqual([]);
  });
});
