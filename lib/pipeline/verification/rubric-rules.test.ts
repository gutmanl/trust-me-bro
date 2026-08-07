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
    const rules = loadRubricRuleSet("se-evidenz-rubrik-v1");
    expect(rules.rubric_version).toBe("se-evidenz-rubrik-v1");
    expect(Object.keys(rules.claim_types).sort()).toEqual([
      "empfehlung",
      "quantitativer_einzelbefund",
      "vergleichende_aussage",
      "wirksamkeitsaussage",
    ]);
  });

  it("rejects unknown rubric versions loudly", () => {
    expect(() => loadRubricRuleSet("se-evidenz-rubrik-v0")).toThrow(
      /no rubric rule file/,
    );
  });

  it("pins the prose prompt template: rules and prose change together", () => {
    const rules = loadRubricRuleSet("se-evidenz-rubrik-v1");
    const template = fs.readFileSync(
      path.join(repoRoot, "lib", "adapters", "prompts", "rubric", "v1.0.0.md"),
    );
    const actual = createHash("sha256").update(template).digest("hex");
    expect(actual).toBe(rules.prompt_template_sha256);
  });
});

describe("evaluateMechanicalRubric (rubric v1)", () => {
  const rules = loadRubricRuleSet("se-evidenz-rubrik-v1");
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

  it("quantitativer Einzelbefund requires a peer-reviewed source", () => {
    expect(
      evaluate("quantitativer_einzelbefund", ["begutachtete_publikation"]),
    ).toBe("erfuellt");
    expect(evaluate("quantitativer_einzelbefund", ["preprint"])).toBe(
      "nicht_erfuellt",
    );
    expect(evaluate("quantitativer_einzelbefund", [])).toBe("nicht_erfuellt");
  });

  it("vergleichende Aussage requires two sources, not vendor-only", () => {
    expect(
      evaluate("vergleichende_aussage", [
        "herstellerdokumentation",
        "preprint",
      ]),
    ).toBe("erfuellt");
    expect(
      evaluate("vergleichende_aussage", ["begutachtete_publikation"]),
    ).toBe("nicht_erfuellt");
    expect(
      evaluate("vergleichende_aussage", [
        "herstellerdokumentation",
        "herstellerdokumentation",
      ]),
    ).toBe("nicht_erfuellt");
  });

  it("Wirksamkeitsaussage needs a pertinent source; empirical nature stays semantic", () => {
    expect(evaluate("wirksamkeitsaussage", ["grauliteratur"])).toBe("erfuellt");
    expect(evaluate("wirksamkeitsaussage", [])).toBe("nicht_erfuellt");
  });

  it("Empfehlung requires convergent source types beyond vendor docs", () => {
    expect(
      evaluate("empfehlung", ["begutachtete_publikation", "grauliteratur"]),
    ).toBe("erfuellt");
    expect(
      evaluate("empfehlung", [
        "begutachtete_publikation",
        "begutachtete_publikation",
      ]),
    ).toBe("nicht_erfuellt");
    expect(
      evaluate("empfehlung", [
        "herstellerdokumentation",
        "herstellerdokumentation",
      ]),
    ).toBe("nicht_erfuellt");
  });
});

describe("combineCalibrationResult", () => {
  it("caps lizenziert to abschwaechen on a mechanical violation", () => {
    expect(combineCalibrationResult("nicht_erfuellt", "lizenziert")).toBe(
      "abschwaechen",
    );
  });

  it("passes everything else through unchanged", () => {
    expect(combineCalibrationResult("erfuellt", "lizenziert")).toBe(
      "lizenziert",
    );
    expect(combineCalibrationResult("nicht_erfuellt", "abschwaechen")).toBe(
      "abschwaechen",
    );
    expect(combineCalibrationResult("nicht_erfuellt", "zur_adjudikation")).toBe(
      "zur_adjudikation",
    );
  });
});
