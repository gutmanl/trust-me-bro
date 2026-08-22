import { describe, expect, it } from "vitest";

import {
  AttributionOutput,
  ExtractionOutput,
  ReferenceParseOutput,
  RepairOutput,
  RubricOutput,
} from "./index";
import { SingleReasoningRubricOutput } from "./rubric";

const validAttribution = {
  relation_type: "supports",
  confidence: 0.92,
  reasoning: "Zahlenwert und Richtung stimmen mit dem Auszug überein.",
};

const validExtraction = {
  claims: [
    {
      text: "LLM-gestuetzte Code-Reviews reduzieren die mediane Reviewzeit um etwa 55 %.",
      claim_type: "quantitative_finding",
      anchor_quote: "reduzieren die mediane Reviewzeit um etwa 55 %",
      evidence: [
        {
          source_id: "src_meyer2025",
          locator: { page: 6, section: "4.2" },
          verbatim_excerpt:
            "…median review time dropped from 42 to 19 minutes (-55%)…",
        },
      ],
    },
  ],
  additional_evidence: [
    {
      claim_text_match: "LLM-Reviews senken die Zahl der Nachbesserungen.",
      evidence: {
        source_id: "src_meyer2025",
        locator: { page: 7 },
        verbatim_excerpt: "…rework rate fell from 18% to 11%…",
      },
    },
  ],
};

/** The go-forward (rubric prompt v1.2.0) three-field shape. */
const validRubric = {
  calibration_result: "licensed",
  reasoning_plain:
    "Die Formulierung passt zu den Belegen. Eine begutachtete Studie deckt " +
    "die Aussage in ihrem Kontext ab.",
  caveat: null,
  reasoning_technical:
    "Die Regel für Zahlenbefunde verlangt eine begutachtete Studie mit " +
    "passendem Kontext; eine solche liegt vor.",
};

const validRepair = {
  suggested_text:
    "Eine Einzelstudie berichtet eine Reduktion der medianen Reviewzeit um 55 %.",
  reasoning: "Abschwächung auf Einzelquellen-Kennzeichnung gemäß Rubrik.",
};

const validReferenceParse = {
  references: [
    {
      raw_text: "Meyer et al. (2025)",
      authors: ["Meyer, A.", "Schmidt, B."],
      year: 2025,
      title: "Impact of LLM-assisted code review on review latency",
      venue: "IEEE TSE",
    },
  ],
};

describe("AttributionOutput", () => {
  it("accepts a valid attribution judgment fragment", () => {
    expect(AttributionOutput.parse(validAttribution)).toEqual(validAttribution);
  });

  it("rejects provenance fields — backend, model and at are stamped by code, never by the LLM", () => {
    for (const field of ["backend", "model", "at"]) {
      const result = AttributionOutput.safeParse({
        ...validAttribution,
        [field]: "spoofed",
      });
      expect(result.success, `field ${field} must be rejected`).toBe(false);
    }
  });

  it("rejects out-of-range confidence", () => {
    expect(
      AttributionOutput.safeParse({ ...validAttribution, confidence: 1.2 })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown relation type", () => {
    expect(
      AttributionOutput.safeParse({
        ...validAttribution,
        relation_type: "agrees",
      }).success,
    ).toBe(false);
  });
});

describe("ExtractionOutput", () => {
  it("accepts a valid extraction result", () => {
    expect(ExtractionOutput.parse(validExtraction)).toEqual(validExtraction);
  });

  it("accepts a claim without evidence (routed to adjudication by the creation gate, not dropped)", () => {
    const withoutEvidence = {
      claims: [{ ...validExtraction.claims[0], evidence: [] }],
      additional_evidence: [],
    };
    expect(ExtractionOutput.parse(withoutEvidence)).toEqual(withoutEvidence);
  });

  it("defaults additional_evidence to empty — a pass that found none may omit it", () => {
    const withoutChannel = { claims: [] };
    expect(ExtractionOutput.parse(withoutChannel)).toEqual({
      claims: [],
      additional_evidence: [],
    });
  });

  it("requires an anchor quote — the model quotes, the pipeline positions", () => {
    const bad = structuredClone(validExtraction) as Record<string, unknown>;
    delete (bad.claims as Array<Record<string, unknown>>)[0].anchor_quote;
    expect(ExtractionOutput.safeParse(bad).success).toBe(false);
  });

  it("rejects a briefing_anchor — v2 never lets the model count paragraphs", () => {
    const bad = structuredClone(validExtraction) as Record<string, unknown>;
    (bad.claims as Array<Record<string, unknown>>)[0].briefing_anchor = "p12";
    expect(ExtractionOutput.safeParse(bad).success).toBe(false);
  });

  it("rejects additional evidence without a claim to match", () => {
    const bad = structuredClone(validExtraction) as Record<string, unknown>;
    delete (bad.additional_evidence as Array<Record<string, unknown>>)[0]
      .claim_text_match;
    expect(ExtractionOutput.safeParse(bad).success).toBe(false);
  });

  it("rejects a malformed source id", () => {
    const bad = structuredClone(validExtraction);
    bad.claims[0].evidence[0].source_id = "meyer2025";
    expect(ExtractionOutput.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown claim type", () => {
    const bad = structuredClone(validExtraction) as Record<string, unknown>;
    (bad.claims as Array<Record<string, unknown>>)[0].claim_type = "meinung";
    expect(ExtractionOutput.safeParse(bad).success).toBe(false);
  });

  it("passes extra locator keys through (loose locator, as in the register)", () => {
    const withParagraph = structuredClone(validExtraction);
    withParagraph.claims[0].evidence[0].locator = {
      page: 6,
      paragraph: 2,
    } as never;
    expect(ExtractionOutput.safeParse(withParagraph).success).toBe(true);
  });
});

describe("RubricOutput", () => {
  it("accepts a valid rubric pre-assessment", () => {
    expect(RubricOutput.parse(validRubric)).toEqual(validRubric);
  });

  it("keeps the verdict enum as the first key of the shape", () => {
    // Under left-to-right decoding, prose emitted after the verdict token
    // cannot mechanically change it. The property dies the moment someone
    // applies the classic "let it reason before it answers" refactor.
    expect(Object.keys(RubricOutput.shape)[0]).toBe("calibration_result");
  });

  it("rejects a calibration result outside the closed enumeration", () => {
    expect(
      RubricOutput.safeParse({ ...validRubric, calibration_result: "ok" })
        .success,
    ).toBe(false);
  });

  it("rejects empty prose in any of the three fields", () => {
    for (const field of [
      "reasoning_plain",
      "caveat",
      "reasoning_technical",
    ] as const) {
      expect(
        RubricOutput.safeParse({ ...validRubric, [field]: "" }).success,
        `${field} must reject the empty string`,
      ).toBe(false);
    }
  });
});

describe("RubricOutput — the plain-language contract's positive counterparts", () => {
  // The rejecting rows live in `plain-contract.test.ts`; these are the
  // acceptances the same clauses must NOT swallow. A contract with only
  // rejection tests is a contract nobody has shown to be satisfiable.
  const RULE_NAME = "Regel für Zahlenbefunde";
  const OPENER = "Die Formulierung passt zu den Belegen.";
  const filler = "Die Aussage bleibt im Rahmen der Belege. ";

  it("accepts a plain layer of exactly the 320-character cap", () => {
    const plain = `${OPENER} ${filler.repeat(20)}`.slice(0, 320);
    expect(
      RubricOutput.safeParse({
        ...validRubric,
        reasoning_plain: plain,
        reasoning_technical: `${RULE_NAME} ist erfüllt. ${filler.repeat(20)}`,
      }).success,
    ).toBe(true);
  });

  it("accepts a plain layer exactly as long as the technical layer", () => {
    const both = `${OPENER} ${filler.repeat(5)}`.slice(0, 200);
    expect(
      RubricOutput.safeParse({
        ...validRubric,
        reasoning_plain: both,
        reasoning_technical:
          `${RULE_NAME} ist erfüllt. ${filler.repeat(5)}`.slice(0, 200),
      }).success,
    ).toBe(true);
  });

  it("accepts a plain layer with no numbers at all (vacuous containment)", () => {
    expect(
      RubricOutput.safeParse({
        ...validRubric,
        reasoning_technical:
          `${RULE_NAME} ist erfüllt; 2 Quellen aus 2025 liegen vor, ` +
          "decken denselben Kontext ab und tragen die Aussage vollständig.",
      }).success,
    ).toBe(true);
  });

  it("accepts a technical layer carrying numbers the plain layer omits", () => {
    expect(
      RubricOutput.safeParse({
        ...validRubric,
        reasoning_plain: `${OPENER} Die Zeit sank deutlich.`,
        reasoning_technical: `${RULE_NAME} ist erfüllt; 55 Prozent bei 1.000 Fällen aus 2025 im Kontext.`,
      }).success,
    ).toBe(true);
  });

  it("accepts a null caveat and a non-empty one alike", () => {
    for (const caveat of [null, "die Stichprobe ist klein."]) {
      expect(
        RubricOutput.safeParse({ ...validRubric, caveat }).success,
        `caveat ${String(caveat)} must be accepted`,
      ).toBe(true);
    }
  });
});

describe("SingleReasoningRubricOutput (frozen: rubric prompts v1.0.0 and v1.1.0)", () => {
  const validSingleReasoning = {
    calibration_result: "licensed",
    reasoning: "Eine begutachtete Studie mit passendem Kontext liegt vor.",
  };

  it("accepts the two-key shape those two templates describe", () => {
    expect(SingleReasoningRubricOutput.parse(validSingleReasoning)).toEqual(
      validSingleReasoning,
    );
  });

  it("rejects empty reasoning", () => {
    expect(
      SingleReasoningRubricOutput.safeParse({
        ...validSingleReasoning,
        reasoning: "",
      }).success,
    ).toBe(false);
  });
});

describe("RepairOutput", () => {
  it("accepts a valid repair proposal", () => {
    expect(RepairOutput.parse(validRepair)).toEqual(validRepair);
  });

  it("rejects a proposal without suggested text", () => {
    expect(
      RepairOutput.safeParse({ reasoning: validRepair.reasoning }).success,
    ).toBe(false);
  });

  it("rejects unknown extra fields", () => {
    expect(
      RepairOutput.safeParse({ ...validRepair, severity: "high" }).success,
    ).toBe(false);
  });
});

describe("ReferenceParseOutput", () => {
  it("accepts a valid reference-parse result", () => {
    expect(ReferenceParseOutput.parse(validReferenceParse)).toEqual(
      validReferenceParse,
    );
  });

  it("accepts an empty references array (no textual citations found)", () => {
    expect(ReferenceParseOutput.parse({ references: [] })).toEqual({
      references: [],
    });
  });

  it("accepts a reference with only the required fields (optionals omitted)", () => {
    const minimal = {
      references: [
        { raw_text: "Some raw citation text", authors: [], title: "A title" },
      ],
    };
    expect(ReferenceParseOutput.parse(minimal)).toEqual(minimal);
  });

  it("rejects a reference without a title", () => {
    const bad = structuredClone(validReferenceParse) as Record<string, unknown>;
    delete (bad.references as Array<Record<string, unknown>>)[0].title;
    expect(ReferenceParseOutput.safeParse(bad).success).toBe(false);
  });

  it("rejects a reasoning field — reference_parse is extraction-shaped, never judgment-shaped", () => {
    const bad = {
      references: [{ ...validReferenceParse.references[0], reasoning: "x" }],
    };
    expect(ReferenceParseOutput.safeParse(bad).success).toBe(false);
  });

  it("rejects references as an object instead of an array", () => {
    expect(ReferenceParseOutput.safeParse({ references: {} }).success).toBe(
      false,
    );
  });
});
