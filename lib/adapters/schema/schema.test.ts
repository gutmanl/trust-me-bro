import { describe, expect, it } from "vitest";

import {
  AttributionOutput,
  ExtractionOutput,
  ReferenceParseOutput,
  RepairOutput,
  RubricOutput,
} from "./index";

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
      briefing_anchor: "p12",
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
};

const validRubric = {
  calibration_result: "licensed",
  reasoning: "Eine begutachtete Studie mit passendem Kontext liegt vor.",
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
    };
    expect(ExtractionOutput.parse(withoutEvidence)).toEqual(withoutEvidence);
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

  it("rejects a calibration result outside the closed enumeration", () => {
    expect(
      RubricOutput.safeParse({ ...validRubric, calibration_result: "ok" })
        .success,
    ).toBe(false);
  });

  it("rejects empty reasoning", () => {
    expect(
      RubricOutput.safeParse({ ...validRubric, reasoning: "" }).success,
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
