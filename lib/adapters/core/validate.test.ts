import { describe, expect, it } from "vitest";

import { PLAIN_VERDICT_PHRASE } from "../schema/plain-contract";
import { AdapterValidationError } from "./errors";
import type { JobKind } from "./jobs";
import { validateJobOutput } from "./validate";

/** A valid two-layer rubric response, perturbed one field at a time. */
const VALID_TWO_LAYER_RUBRIC = {
  calibration_result: "licensed",
  reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Eine begutachtete Studie deckt die Aussage ab.`,
  caveat: null as string | null,
  reasoning_technical:
    "Die Regel für Zahlenbefunde verlangt eine begutachtete Studie mit " +
    "passendem Kontext; eine solche liegt vor und traegt die Aussage.",
};

function twoLayer(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...VALID_TWO_LAYER_RUBRIC, ...patch };
}

/** The two-key shape rubric prompts v1.0.0 and v1.1.0 ask for. */
const VALID_SINGLE_REASONING_RUBRIC = {
  calibration_result: "licensed",
  reasoning: "Eine begutachtete Studie mit passendem Kontext liegt vor.",
};

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
  // The two-layer contract, at the BOUNDARY: every clause must reach
  // validateJobOutput as an AdapterValidationError, not merely fail a schema
  // in isolation. The clause-by-clause table lives in
  // schema/plain-contract.test.ts.
  [
    "rubric",
    "English enum token in the plain layer",
    "1.2.0",
    twoLayer({
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Die Quelle ist ein preprint.`,
    }),
  ],
  [
    "rubric",
    "plain layer over the character cap",
    "1.2.0",
    twoLayer({
      reasoning_plain:
        `${PLAIN_VERDICT_PHRASE.licensed} ` + "sehr lang. ".repeat(60),
    }),
  ],
  [
    "rubric",
    "technical layer without the German rule-name anchor",
    "1.2.0",
    twoLayer({
      reasoning_technical:
        "Die Belege genuegen dem Bewertungsschema in diesem Kontext.",
    }),
  ],
  [
    "rubric",
    "blank line inside a prose field",
    "1.2.0",
    twoLayer({
      caveat: "die Studie ist klein.\n\nUnd alt.",
    }),
  ],
  [
    "rubric",
    "number in the plain layer absent from the technical layer",
    "1.2.0",
    twoLayer({
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Die Zeit sank um 55 Prozent.`,
    }),
  ],
  [
    "rubric",
    "role marker at the start of a prose field",
    "1.2.0",
    twoLayer({ caveat: "Jedoch: die Studie ist klein." }),
  ],
  ["rubric", "empty-string caveat", "1.2.0", twoLayer({ caveat: "" })],
  [
    "rubric",
    "plain layer opening with another verdict's phrase",
    "1.2.0",
    twoLayer({
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.weakened} Die Belege tragen die Aussage.`,
    }),
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

/**
 * The VERSION dimension — a property of the boundary, not of the contract,
 * which is why it lives here and not in `schema/plain-contract.test.ts`.
 *
 * The dispatch table used to be keyed on job kind alone. Widening a shape in
 * place therefore invalidated every response from every project pinned to an
 * older template: three failed attempts and an escalated claim per
 * generation, reached by omission rather than by an attacker, and presenting
 * as a model-compliance problem. These rows are what keep the two halves —
 * what a template asks for and what the boundary accepts — the same
 * statement.
 */
describe("validateJobOutput — the accepted shape is selected by prompt version", () => {
  it.each(["1.0.0", "1.1.0"])(
    "accepts the two-key rubric shape at prompt version %s",
    (promptVersion) => {
      expect(
        validateJobOutput(
          "mock",
          "rubric",
          promptVersion,
          VALID_SINGLE_REASONING_RUBRIC,
        ),
      ).toEqual(VALID_SINGLE_REASONING_RUBRIC);
    },
  );

  it("accepts the three-field rubric shape at prompt version 1.2.0", () => {
    expect(
      validateJobOutput("mock", "rubric", "1.2.0", VALID_TWO_LAYER_RUBRIC),
    ).toEqual(VALID_TWO_LAYER_RUBRIC);
  });

  it("rejects the two-key shape at prompt version 1.2.0", () => {
    // Without this the two-layer contract is optional: a model could escape
    // it entirely by answering in the previous vintage's shape.
    expect(() =>
      validateJobOutput(
        "mock",
        "rubric",
        "1.2.0",
        VALID_SINGLE_REASONING_RUBRIC,
      ),
    ).toThrow(AdapterValidationError);
  });

  it.each(["1.0.0", "1.1.0"])(
    "rejects the three-field shape at prompt version %s",
    (promptVersion) => {
      expect(() =>
        validateJobOutput(
          "mock",
          "rubric",
          promptVersion,
          VALID_TWO_LAYER_RUBRIC,
        ),
      ).toThrow(AdapterValidationError);
    },
  );

  it("selects the two-layer contract for a version naming no known template", () => {
    // The defaulting direction: an unrecognised version resolves to the
    // CURRENT contract, so a fixture carrying an invented version string
    // fails loudly instead of silently skipping the contract. Fix such a
    // fixture by naming a real template version, never by widening the
    // frozen legacy table.
    expect(() =>
      validateJobOutput(
        "mock",
        "rubric",
        "9.9.9",
        VALID_SINGLE_REASONING_RUBRIC,
      ),
    ).toThrow(AdapterValidationError);
    expect(
      validateJobOutput("mock", "rubric", "9.9.9", VALID_TWO_LAYER_RUBRIC),
    ).toEqual(VALID_TWO_LAYER_RUBRIC);
  });

  it("attaches NO plain-language clause to the frozen two-key shape", () => {
    // A reasoning that would violate several plain-layer clauses if they
    // applied: an English enum token, an internal id, a bracket citation and
    // a blank line. It must still validate at a legacy version — this is the
    // assertion that stops a later reader "improving" the frozen shape by
    // attaching the contract to it and silently breaking every existing
    // project.
    const wouldViolate = {
      calibration_result: "licensed",
      reasoning:
        "Die Regel effectiveness_statement ist erfüllt; siehe ev_0001 " +
        "und [3].\n\nJedoch: nur eine Quelle.",
    };
    expect(validateJobOutput("mock", "rubric", "1.1.0", wouldViolate)).toEqual(
      wouldViolate,
    );
  });
});
