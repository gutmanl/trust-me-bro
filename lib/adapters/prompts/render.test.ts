import { describe, expect, it } from "vitest";

import type {
  AttributionInput,
  ExtractionInput,
  JobKind,
  RepairInput,
  RubricInput,
} from "../core/jobs";
import { CURRENT_PROMPT_VERSION, renderPromptForJob } from "./index";
import { substitute } from "./render";

const claim = {
  id: "clm_0001",
  text: "LLM-gestuetzte Code-Reviews reduzieren die mediane Reviewzeit um etwa 55 %.",
  claim_type: "quantitativer_einzelbefund",
  briefing_anchor: "p12",
} as const;

const evidence = {
  id: "ev_0001",
  source_id: "src_meyer2025",
  locator: { page: 6, section: "4.2" },
  verbatim_excerpt: "…median review time dropped from 42 to 19 minutes (-55%)…",
} as const;

const inputs: { [K in JobKind]: unknown } = {
  extraction: {
    research_question:
      "Reduzieren LLM-gestuetzte Code-Review-Werkzeuge die Reviewzeit messbar?",
    briefing_text: "Briefing-Absatz p12 …",
    sources: [{ id: "src_meyer2025", citation: "Meyer (2025), IEEE TSE" }],
  } satisfies ExtractionInput,
  attribution: { claim, evidence } satisfies AttributionInput,
  rubric: {
    claim,
    evidence: [evidence],
    rubric_version: "se-evidenz-rubrik-v1",
  } satisfies RubricInput,
  repair: {
    claim,
    evidence: [evidence],
    complaint: {
      category: "leitsatz_nicht_herleitbar",
      reason: "Der Auszug trägt die Verallgemeinerung nicht.",
    },
  } satisfies RepairInput,
};

describe("substitute", () => {
  it("replaces every placeholder with its variable", () => {
    expect(substitute("a {{x}} b {{y}}", { x: "1", y: "2" })).toBe("a 1 b 2");
  });

  it("throws when a placeholder has no variable", () => {
    expect(() => substitute("a {{x}} {{missing}}", { x: "1" })).toThrow(
      /missing/,
    );
  });

  it("throws when a variable has no placeholder (typo guard)", () => {
    expect(() => substitute("a {{x}}", { x: "1", unused: "2" })).toThrow(
      /unused/,
    );
  });

  it("replaces repeated placeholders everywhere", () => {
    expect(substitute("{{x}}-{{x}}", { x: "1" })).toBe("1-1");
  });
});

describe("renderPromptForJob", () => {
  it.each(Object.keys(inputs) as JobKind[])(
    "renders the %s template without unresolved placeholders",
    (kind) => {
      const prompt = renderPromptForJob(kind, inputs[kind] as never);
      expect(prompt.text).not.toMatch(/\{\{/);
      expect(prompt.version).toBe(CURRENT_PROMPT_VERSION[kind]);
      expect(prompt.template_sha256).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it("interpolates the job input into the attribution prompt", () => {
    const prompt = renderPromptForJob(
      "attribution",
      inputs.attribution as AttributionInput,
    );
    expect(prompt.text).toContain(claim.text);
    expect(prompt.text).toContain(evidence.verbatim_excerpt);
  });

  it("renders deterministically for identical input", () => {
    const a = renderPromptForJob(
      "attribution",
      inputs.attribution as AttributionInput,
    );
    const b = renderPromptForJob(
      "attribution",
      inputs.attribution as AttributionInput,
    );
    expect(a).toEqual(b);
  });

  it("throws a helpful error for an unknown template version", () => {
    expect(() =>
      renderPromptForJob(
        "attribution",
        inputs.attribution as AttributionInput,
        "9.9.9",
      ),
    ).toThrow(/attribution.*9\.9\.9/);
  });
});
