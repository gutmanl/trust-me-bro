import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../../register";
import { deriveMechanicalCaps } from "./mechanical-cap";

/** Minimal register slice: one source, claims added per test. Cast through
 * unknown because only the fields the derivation reads are modelled. */
function registerWith(
  claims: unknown[],
  rubricVersion = "se-evidence-rubric-v1",
): ClaimsRegister {
  return {
    config: { rubric_version: rubricVersion },
    sources: [
      {
        id: "src_0001",
        custom: { source_type: "peer_reviewed_publication" },
      },
    ],
    claims,
  } as unknown as ClaimsRegister;
}

const claim = (overrides: Record<string, unknown>): unknown => ({
  id: "clm_0001",
  claim_type: "comparative_statement",
  calibration_result: "weakened",
  evidence: [
    {
      id: "ev_0001",
      source_id: "src_0001",
      relation_type: "supports",
    },
  ],
  ...overrides,
});

describe("deriveMechanicalCaps", () => {
  it("caps a comparative_statement with one pertinent source", () => {
    const caps = deriveMechanicalCaps(registerWith([claim({})]));
    expect(caps.clm_0001).toMatchObject({
      claimType: "comparative_statement",
      violations: ["min_pertinent_sources"],
      pertinentSources: 1,
    });
    expect(caps.clm_0001.rule.min_pertinent_sources).toBe(2);
  });

  it("does not cap a quantitative_finding with one peer-reviewed source", () => {
    const caps = deriveMechanicalCaps(
      registerWith([claim({ claim_type: "quantitative_finding" })]),
    );
    expect(caps).toEqual({});
  });

  it("ignores claims without a pre-check verdict", () => {
    const caps = deriveMechanicalCaps(
      registerWith([claim({ calibration_result: undefined })]),
    );
    expect(caps).toEqual({});
  });

  it("counts distinct pertinent sources, not evidence entries", () => {
    const caps = deriveMechanicalCaps(
      registerWith([
        claim({
          evidence: [
            { id: "ev_0001", source_id: "src_0001", relation_type: "supports" },
            {
              id: "ev_0002",
              source_id: "src_0001",
              relation_type: "partially_supports",
            },
            // Not pertinent: contradicting or unresolved evidence.
            { id: "ev_0003", source_id: "src_0001" },
          ],
        }),
      ]),
    );
    expect(caps.clm_0001.pertinentSources).toBe(1);
  });

  it("degrades to an empty map on an unresolvable rubric pin", () => {
    const caps = deriveMechanicalCaps(
      registerWith([claim({})], "se-evidence-rubric-does-not-exist"),
    );
    expect(caps).toEqual({});
  });
});
