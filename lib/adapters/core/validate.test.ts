import { describe, expect, it } from "vitest";

import { AdapterValidationError } from "./errors";
import type { JobKind } from "./jobs";
import { validateJobOutput } from "./validate";

/**
 * TMB-19 acceptance: invalid outputs never reach the register. Every path
 * from a backend to the register runs through validateJobOutput (backends
 * validate before resolving, the orchestrator re-validates) — this table
 * pins the rejection behavior per job kind against typical LLM failure
 * shapes.
 */
const invalidByKind: Array<[JobKind, string, unknown]> = [
  ["attribution", "empty object", {}],
  ["attribution", "prose instead of structure", "stuetzt"],
  ["attribution", "null", null],
  [
    "attribution",
    "confidence out of range",
    { relation_type: "stuetzt", confidence: 1.4, reasoning: "x" },
  ],
  [
    "attribution",
    "relation type from the wrong vocabulary",
    { relation_type: "supported", confidence: 0.5, reasoning: "x" },
  ],
  [
    "attribution",
    "spoofed provenance fields",
    {
      relation_type: "stuetzt",
      confidence: 0.5,
      reasoning: "x",
      backend: "claude",
      model: "spoofed",
      at: "2026-08-06T09:00:00Z",
    },
  ],
  ["extraction", "claims as object instead of array", { claims: {} }],
  [
    "extraction",
    "claim without briefing anchor",
    {
      claims: [{ text: "x", claim_type: "empfehlung", evidence: [] }],
    },
  ],
  [
    "extraction",
    "evidence with malformed source id",
    {
      claims: [
        {
          text: "x",
          claim_type: "empfehlung",
          briefing_anchor: "p1",
          evidence: [
            { source_id: "meyer", locator: {}, verbatim_excerpt: "y" },
          ],
        },
      ],
    },
  ],
  [
    "rubric",
    "free-text calibration result",
    { calibration_result: "passt schon", reasoning: "x" },
  ],
  ["rubric", "missing reasoning", { calibration_result: "lizenziert" }],
  ["repair", "empty suggested text", { suggested_text: "", reasoning: "x" }],
  [
    "repair",
    "extra fields",
    { suggested_text: "x", reasoning: "y", diff: "z" },
  ],
];

describe("validateJobOutput", () => {
  it.each(invalidByKind)("rejects %s output: %s", (kind, _label, candidate) => {
    expect(() => validateJobOutput("mock", kind, candidate)).toThrow(
      AdapterValidationError,
    );
  });

  it("returns the parsed output for a valid candidate", () => {
    const valid = {
      relation_type: "widerspricht",
      confidence: 0.3,
      reasoning: "Der Auszug widerspricht dem Claim.",
    };
    expect(validateJobOutput("mock", "attribution", valid)).toEqual(valid);
  });
});
