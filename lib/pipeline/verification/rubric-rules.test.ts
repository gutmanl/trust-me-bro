import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { SourceType } from "../../register";
import {
  combineCalibrationResult,
  evaluateMechanicalRubric,
  loadRubricRuleSet,
} from "./rubric-rules";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

describe("loadRubricRuleSet", () => {
  it("loads and validates the v1 rule file with a rule per claim type", () => {
    const rules = loadRubricRuleSet("se-evidence-rubric-v1");
    expect(rules.rubric_version).toBe("se-evidence-rubric-v1");
    expect(Object.keys(rules.claim_types).sort()).toEqual([
      "comparative_statement",
      "effectiveness_statement",
      "quantitative_finding",
      "recommendation",
    ]);
  });

  it("rejects unknown rubric versions loudly", () => {
    expect(() => loadRubricRuleSet("se-evidence-rubric-v0")).toThrow(
      /no rubric rule file/,
    );
  });

  it("pins the prose prompt template: rules and prose change together", () => {
    const rules = loadRubricRuleSet("se-evidence-rubric-v1");
    const template = fs.readFileSync(
      path.join(repoRoot, "lib", "adapters", "prompts", "rubric", "v1.0.0.md"),
    );
    const actual = createHash("sha256").update(template).digest("hex");
    expect(actual).toBe(rules.prompt_template_sha256);
  });
});

describe("evaluateMechanicalRubric (rubric v1)", () => {
  const rules = loadRubricRuleSet("se-evidence-rubric-v1");
  const rule = (claimType: keyof typeof rules.claim_types) => {
    const found = rules.claim_types[claimType];
    if (!found) {
      throw new Error(`missing rule for ${claimType}`);
    }
    return found;
  };
  const evaluate = (
    claimType: keyof typeof rules.claim_types,
    types: SourceType[],
  ) => evaluateMechanicalRubric(types, rule(claimType));

  it("quantitative finding requires a peer-reviewed source", () => {
    expect(
      evaluate("quantitative_finding", ["peer_reviewed_publication"]),
    ).toBe("met");
    expect(evaluate("quantitative_finding", ["preprint"])).toBe("not_met");
    expect(evaluate("quantitative_finding", [])).toBe("not_met");
  });

  it("comparative statement requires two sources, not vendor-only", () => {
    expect(
      evaluate("comparative_statement", ["vendor_documentation", "preprint"]),
    ).toBe("met");
    expect(
      evaluate("comparative_statement", ["peer_reviewed_publication"]),
    ).toBe("not_met");
    expect(
      evaluate("comparative_statement", [
        "vendor_documentation",
        "vendor_documentation",
      ]),
    ).toBe("not_met");
  });

  it("effectiveness statement needs a pertinent source; empirical nature stays semantic", () => {
    expect(evaluate("effectiveness_statement", ["grey_literature"])).toBe(
      "met",
    );
    expect(evaluate("effectiveness_statement", [])).toBe("not_met");
  });

  it("recommendation requires convergent source types beyond vendor docs", () => {
    expect(
      evaluate("recommendation", [
        "peer_reviewed_publication",
        "grey_literature",
      ]),
    ).toBe("met");
    expect(
      evaluate("recommendation", [
        "peer_reviewed_publication",
        "peer_reviewed_publication",
      ]),
    ).toBe("not_met");
    expect(
      evaluate("recommendation", [
        "vendor_documentation",
        "vendor_documentation",
      ]),
    ).toBe("not_met");
  });
});

describe("combineCalibrationResult", () => {
  it("caps licensed to weakened on a mechanical violation", () => {
    expect(combineCalibrationResult("not_met", "licensed")).toBe("weakened");
  });

  it("passes everything else through unchanged", () => {
    expect(combineCalibrationResult("met", "licensed")).toBe("licensed");
    expect(combineCalibrationResult("not_met", "weakened")).toBe("weakened");
    expect(combineCalibrationResult("not_met", "pending_adjudication")).toBe(
      "pending_adjudication",
    );
  });
});
