import { describe, expect, it } from "vitest";

import {
  exampleClaim as claim,
  exampleEvidence as evidence,
  exampleInputs as inputs,
} from "../__fixtures__/jobs";
import type { AttributionInput, JobKind } from "../core/jobs";
import { CURRENT_PROMPT_VERSION, renderPromptForJob } from "./index";
import { substitute } from "./render";

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

  it("interpolates the pass scope and the known claims into the extraction prompt", () => {
    const input = inputs.extraction;
    const prompt = renderPromptForJob("extraction", input);
    expect(prompt.text).toContain(input.briefing_text);
    expect(prompt.text).toContain(input.research_question);
    // The scoped source travels as its own JSON block, separate from the
    // full citable corpus — the pass focuses on it, but may cite the rest.
    expect(prompt.text).toContain(JSON.stringify(input.target_source, null, 2));
    expect(prompt.text).toContain(JSON.stringify(input.known_claims, null, 2));
    expect(prompt.text).toContain("anchor_quote");
    expect(prompt.text).not.toContain("briefing_anchor");
  });

  it("renders the sweep pass with a null scope, not an omitted one", () => {
    const prompt = renderPromptForJob("extraction", {
      ...inputs.extraction,
      target_source: null,
      known_claims: [],
    });
    expect(prompt.text).toContain("null");
    expect(prompt.text).not.toMatch(/\{\{/);
  });

  it("interpolates the briefing text and already-detected spans into the reference_parse prompt", () => {
    const prompt = renderPromptForJob(
      "reference_parse",
      inputs.reference_parse,
    );
    expect(prompt.text).toContain(inputs.reference_parse.briefing_text);
    for (const span of inputs.reference_parse.already_detected) {
      expect(prompt.text).toContain(span);
    }
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
