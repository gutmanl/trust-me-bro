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
 *
 * The fourth column is the resolved PROMPT TEMPLATE VERSION the candidate is
 * validated at. It is a column rather than a threaded constant because the
 * accepted shape is partitioned by version for `attribution` and `rubric`:
 * a row without its own version would be asserting against whichever
 * contract happened to be the default.
 */
const invalidByKind: Array<[JobKind, string, string, unknown]> = [
  ["attribution", "empty object", "1.1.0", {}],
  ["attribution", "prose instead of structure", "1.1.0", "supports"],
  ["attribution", "null", "1.1.0", null],
  [
    "attribution",
    "confidence out of range",
    "1.1.0",
    { relation_type: "supports", confidence: 1.4, reasoning: "x" },
  ],
  [
    "attribution",
    "relation type from the wrong vocabulary",
    "1.1.0",
    { relation_type: "supported", confidence: 0.5, reasoning: "x" },
  ],
  [
    "attribution",
    "spoofed provenance fields",
    "1.1.0",
    {
      relation_type: "supports",
      confidence: 0.5,
      reasoning: "x",
      backend: "claude",
      model: "spoofed",
      at: "2026-08-06T09:00:00Z",
    },
  ],
  ["extraction", "claims as object instead of array", "2.0.0", { claims: {} }],
  [
    "extraction",
    "claim without briefing anchor",
    "2.0.0",
    {
      claims: [{ text: "x", claim_type: "recommendation", evidence: [] }],
    },
  ],
  [
    "extraction",
    "evidence with malformed source id",
    "2.0.0",
    {
      claims: [
        {
          text: "x",
          claim_type: "recommendation",
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
    "1.1.0",
    { calibration_result: "passt schon", reasoning: "x" },
  ],
  ["rubric", "missing reasoning", "1.1.0", { calibration_result: "licensed" }],
  [
    "repair",
    "empty suggested text",
    "1.0.0",
    { suggested_text: "", reasoning: "x" },
  ],
  [
    "repair",
    "extra fields",
    "1.0.0",
    { suggested_text: "x", reasoning: "y", diff: "z" },
  ],
  [
    "reference_parse",
    "references as object instead of array",
    "1.1.1",
    { references: {} },
  ],
  [
    "reference_parse",
    "reference without a title",
    "1.1.1",
    { references: [{ raw_text: "x", authors: [] }] },
  ],
  [
    "reference_parse",
    "reference carrying a reasoning field (judgment-shaped, not allowed here)",
    "1.1.1",
    {
      references: [{ raw_text: "x", authors: [], title: "y", reasoning: "z" }],
    },
  ],
];

describe("validateJobOutput", () => {
  it.each(invalidByKind)(
    "rejects %s output: %s (prompt %s)",
    (kind, _label, promptVersion, candidate) => {
      expect(() =>
        validateJobOutput("mock", kind, promptVersion, candidate),
      ).toThrow(AdapterValidationError);
    },
  );

  it("returns the parsed output for a valid candidate", () => {
    const valid = {
      relation_type: "contradicts",
      confidence: 0.3,
      reasoning: "Der Auszug widerspricht dem Claim.",
    };
    expect(validateJobOutput("mock", "attribution", "1.1.0", valid)).toEqual(
      valid,
    );
  });
});
