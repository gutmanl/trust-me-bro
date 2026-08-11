import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../schema/register";
import exampleProject from "../schema/__fixtures__/example-project.json";
import { findIntegrityProblems } from "./validate";

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("findIntegrityProblems", () => {
  it("finds no problems in the example project", () => {
    expect(
      findIntegrityProblems(exampleProject as unknown as ClaimsRegister),
    ).toEqual([]);
  });

  it("flags an anchor_change referencing an unknown claim (workbench epic)", () => {
    const register = clone(exampleProject) as unknown as ClaimsRegister;
    register.project_events.push({
      seq: 2,
      at: "2026-08-10T08:05:00Z",
      actor: "human:lg",
      event: "claim_anchor_revised",
      reason: "Anker manuell korrigiert.",
      anchor_change: {
        claim_id: "clm_9999",
        previous_anchor: "p12",
        new_anchor: "p14",
      },
      prev_hash: "aa".repeat(32),
      hash: "bb".repeat(32),
    });
    const problems = findIntegrityProblems(register);
    expect(problems).toContain(
      "project event 2 anchor_change references unknown claim clm_9999",
    );
  });

  it("accepts an anchor_change referencing an existing claim", () => {
    const register = clone(exampleProject) as unknown as ClaimsRegister;
    register.project_events.push({
      seq: 2,
      at: "2026-08-10T08:05:00Z",
      actor: "human:lg",
      event: "claim_anchor_revised",
      reason: "Anker manuell korrigiert.",
      anchor_change: {
        claim_id: "clm_0001",
        previous_anchor: "p12",
        new_anchor: "p14",
      },
      prev_hash: "aa".repeat(32),
      hash: "bb".repeat(32),
    });
    expect(findIntegrityProblems(register)).toEqual([]);
  });
});
