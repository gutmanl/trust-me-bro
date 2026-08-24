import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { CalibrationResult, ClaimType, SourceType } from "../../register";

/**
 * Machine-readable half of the SE-Evidenz-Rubrik (TMB-30): the mechanically
 * checkable source-type conditions per claim type live as a versioned JSON
 * rule file next to this module; the semantic half (context fit, empirical
 * vs. experience report, independence of sources) stays with the LLM rubric
 * job whose prompt template carries the prose rules. A rule change is a new
 * rubric version — both halves plus the thesis table change together, and
 * the checksum pin below fails the build when the prose drifts alone.
 */

export const ClaimTypeRule = z.strictObject({
  /** Minimum number of DISTINCT pertinent sources (not evidence entries). */
  min_pertinent_sources: z.int().min(1),
  /** At least one pertinent source must have one of these types. */
  required_source_types_any: z.array(SourceType).nonempty().optional(),
  /** Minimum number of distinct source types among pertinent sources. */
  min_source_type_diversity: z.int().min(1).optional(),
  /** Not satisfied when ALL pertinent sources fall into these types
   * (e.g. vendor documentation alone = Selbstauskunft). */
  insufficient_if_only: z.array(SourceType).nonempty().optional(),
});
export type ClaimTypeRule = z.infer<typeof ClaimTypeRule>;

export const RubricRuleSet = z.strictObject({
  /** The project's whole prose vintage, in one string: this selects the
   * mechanical rule table below, the rubric prompt template AND — since the
   * attribution fields were added — the attribution prompt template. The name
   * is under-descriptive by history rather than by design; renaming it would
   * be a change to `ProjectConfig.rubric_version`, i.e. a register schema
   * change with a normative thesis-appendix entry, which the prompt-contract
   * work must not make. Revisit when a THIRD pinnable job kind appears: at
   * that point the six fields want to become one nested `prompt_templates`
   * object and the config field has earned its rename. */
  rubric_version: z.string().min(1),
  /** Which rubric prompt TEMPLATE file this rule set pairs with
   * (lib/adapters/prompts/rubric/v<version>.md). Coupling the template
   * version to the per-project `rubric_version` is what lets an existing
   * project keep its original prompt forever while new projects default to
   * the newest rule set. Defaults to "1.0.0" so the pre-existing v1 rule
   * file — which predates this field — parses unchanged. */
  prompt_template_version: z.string().min(1).default("1.0.0"),
  /** Pins the prose prompt template (lib/adapters/prompts/rubric/…): the
   * consistency test hashes the template and compares — prose and rules
   * describe the SAME rubric and may only change together. */
  prompt_template_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Which ATTRIBUTION prompt template file this rule set pairs with
   * (lib/adapters/prompts/attribution/v<version>.md). Attribution used to
   * resolve its version from the global `CURRENT_PROMPT_VERSION` while rubric
   * resolved it from here, so one settings field moved only half a project's
   * prose vintage and a re-run could mix judgment prose of one vintage with
   * calibration prose of another.
   *
   * The default is "1.1.0" and NOT "1.0.0" — deliberately asymmetric with
   * `prompt_template_version` above. A default must describe what a project
   * carrying a rule file that predates the field resolves TODAY: for rubric
   * that is 1.0.0 (the rubric path already read the rule file), for
   * attribution it is the global constant, which is 1.1.0. Defaulting to
   * 1.0.0 here would silently change the prompt of every existing project
   * while claiming to be a compatibility default. */
  attribution_template_version: z.string().min(1).default("1.1.0"),
  /** Pins the attribution prose template the same way `prompt_template_sha256`
   * pins the rubric one. Optional ONLY because the two pre-existing rule files
   * (v1, v1.1) have no attribution pin to declare; from v1.2 onward the
   * consistency test in rubric-rules.test.ts requires it present and matching.
   * A red pin means the template was edited in place, which the versioning
   * rule forbids — the fix is a new version file, never an updated pin. */
  attribution_template_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  claim_types: z.record(ClaimType, ClaimTypeRule),
});
export type RubricRuleSet = z.infer<typeof RubricRuleSet>;

// Anchored at the process working directory, NOT import.meta.url (TMB-48):
// the production server bundle relocates this module, while dev server,
// tests and the packaged launcher all run with a cwd containing lib/ (the
// packaging step copies the rule files into the standalone directory).
const rulesDir = path.join(
  process.cwd(),
  "lib",
  "pipeline",
  "verification",
  "rules",
);

/** Loads and validates the rule file of one rubric version. Throws when the
 * version has no rule file — an unprüfbare rubric version is a config error,
 * never a silent pass. */
export function loadRubricRuleSet(rubricVersion: string): RubricRuleSet {
  const file = path.join(rulesDir, `${rubricVersion}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`no rubric rule file for version "${rubricVersion}"`);
  }
  const parsed = RubricRuleSet.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (parsed.rubric_version !== rubricVersion) {
    throw new Error(
      `rubric rule file ${file} declares version "${parsed.rubric_version}"`,
    );
  }
  return parsed;
}

/**
 * Mechanical minimum-evidence check for one claim: evaluated over the types
 * of the claim's DISTINCT pertinent sources (relation supports or
 * partially_supports), one entry per source. Pure — the caller derives the
 * list from the register.
 */
export type MechanicalViolation =
  | "min_pertinent_sources"
  | "required_source_types_any"
  | "min_source_type_diversity"
  | "insufficient_if_only";

/**
 * Every violated condition, not just the first (verdict-driven repair): the
 * cap display and the repair-suggestion eligibility need to SAY which rule
 * failed, which a bare met/not_met cannot. `evaluateMechanicalRubric` stays
 * the run-time verdict and is defined on top of this list, so the two can
 * never disagree.
 */
export function evaluateMechanicalViolations(
  pertinentSourceTypes: readonly SourceType[],
  rule: ClaimTypeRule,
): MechanicalViolation[] {
  const violations: MechanicalViolation[] = [];
  if (pertinentSourceTypes.length < rule.min_pertinent_sources) {
    violations.push("min_pertinent_sources");
  }
  if (
    rule.required_source_types_any &&
    !pertinentSourceTypes.some((type) =>
      rule.required_source_types_any?.includes(type),
    )
  ) {
    violations.push("required_source_types_any");
  }
  if (
    rule.min_source_type_diversity !== undefined &&
    new Set(pertinentSourceTypes).size < rule.min_source_type_diversity
  ) {
    violations.push("min_source_type_diversity");
  }
  if (
    rule.insufficient_if_only &&
    pertinentSourceTypes.every((type) =>
      rule.insufficient_if_only?.includes(type),
    )
  ) {
    violations.push("insufficient_if_only");
  }
  return violations;
}

export function evaluateMechanicalRubric(
  pertinentSourceTypes: readonly SourceType[],
  rule: ClaimTypeRule,
): "met" | "not_met" {
  return evaluateMechanicalViolations(pertinentSourceTypes, rule).length > 0
    ? "not_met"
    : "met";
}

/**
 * A mechanical violation caps the LLM's proposal: it can never upgrade the
 * verdict, only downgrade `licensed` to `weakened` — `weakened`
 * and `pending_adjudication` already sit at or below the cap.
 */
export function combineCalibrationResult(
  mechanical: "met" | "not_met",
  llmResult: CalibrationResult,
): CalibrationResult {
  return mechanical === "not_met" && llmResult === "licensed"
    ? "weakened"
    : llmResult;
}
