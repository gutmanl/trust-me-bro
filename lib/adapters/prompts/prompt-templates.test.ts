import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { exampleInputs } from "../__fixtures__/jobs";
import { GERMAN_RULE_NAMES } from "../schema/plain-contract";
import { rubricOutputSchemaFor } from "../schema/rubric";
import { renderPromptForJob } from "./index";

/**
 * Three invariants whose violation is otherwise SILENT AND PERMANENT. They
 * should be trivially green the day they are written — that is the point:
 * these are regression fences, not discovery.
 *
 * The repo-root + readFileSync idiom is borrowed from
 * `lib/pipeline/verification/rubric-rules.test.ts`; no content-assertion
 * analog existed before this file.
 *
 * Attribution rows arrive with 03-03, which gives attribution its own
 * v1.2.0 templates.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const rubricDir = path.join(repoRoot, "lib", "adapters", "prompts", "rubric");

/**
 * Every rubric template file on disk, as `[version, absolutePath]`. Iterating
 * the directory rather than listing versions is deliberate: a template added
 * later is covered without anyone remembering to add a row.
 */
function rubricTemplates(): Array<[string, string]> {
  return fs
    .readdirSync(rubricDir)
    .filter((name) => name.startsWith("v") && name.endsWith(".md"))
    .sort()
    .map((name) => [name.slice(1, -3), path.join(rubricDir, name)]);
}

/** The template text, split around the first fenced block after `## Output`. */
function outputBlock(templatePath: string): {
  before: string;
  block: string;
  after: string;
} {
  const text = fs.readFileSync(templatePath, "utf8");
  const headingAt = text.indexOf("## Output");
  expect(headingAt, `${templatePath} has no ## Output heading`).toBeGreaterThan(
    -1,
  );
  const openAt = text.indexOf("```", headingAt);
  const bodyAt = text.indexOf("\n", openAt) + 1;
  const closeAt = text.indexOf("```", bodyAt);
  expect(closeAt, `${templatePath} has no closed fence`).toBeGreaterThan(
    bodyAt,
  );
  return {
    before: text.slice(0, bodyAt),
    block: text.slice(bodyAt, closeAt),
    after: text.slice(closeAt),
  };
}

/** The quoted JSON keys of that block, in the order the template lists them. */
function declaredKeys(templatePath: string): string[] {
  return [
    ...outputBlock(templatePath).block.matchAll(/^\s*"([a-z_]+)":/gm),
  ].map((match) => match[1]);
}

function placeholders(templatePath: string): string[] {
  const text = fs.readFileSync(templatePath, "utf8");
  return [...new Set(text.match(/\{\{[a-z_]+\}\}/g) ?? [])].sort();
}

describe("rubric templates: the verdict enum is the first key", () => {
  // The mechanism: a response is decoded left to right, so the verdict token
  // is produced before any prose and prose written afterwards cannot
  // mechanically pull the verdict with it. The property dies the moment
  // someone applies the classic "let it reason before it answers" refactor —
  // which is exactly why the two OLDER versions are asserted here too. The
  // invariant is not new, and a regression in a shipped template is worse
  // than one in a file nobody has run yet.
  it.each(rubricTemplates())(
    "%s declares calibration_result first",
    (_version, templatePath) => {
      expect(declaredKeys(templatePath)[0]).toBe("calibration_result");
    },
  );
});

describe("rubric templates: the placeholder set is stable across versions", () => {
  // The PROMPT-06 kill shot. `substitute` is strict in BOTH directions and
  // `buildVars` is keyed on JobKind, not on version — so a single new
  // placeholder in a v1.2.0 template instantly stops v1.0.0 and v1.1.0 from
  // rendering for that kind, which destroys PROMPT-06 for every existing
  // project. This is the easiest available way to break the phase's own
  // headline requirement.
  it("every rubric template declares the same placeholders", () => {
    const sets = rubricTemplates().map(([version, templatePath]) => [
      version,
      placeholders(templatePath),
    ]);
    const [, first] = sets[0] as [string, string[]];
    for (const [version, set] of sets as Array<[string, string[]]>) {
      expect(set, `rubric v${version} placeholder set`).toEqual(first);
    }
  });

  it.each(rubricTemplates())("renders at %s without throwing", (version) => {
    // A successful strict render IS the assertion that this template's
    // placeholder set equals buildVars' rubric key set exactly: substitute
    // throws on an unfilled placeholder AND on an unused variable.
    const rendered = renderPromptForJob(
      "rubric",
      exampleInputs.rubric,
      version,
    );
    expect(rendered.version).toBe(version);
    expect(rendered.text.length).toBeGreaterThan(0);
    expect(rendered.text).not.toMatch(/\{\{[a-z_]+\}\}/);
  });
});

describe("rubric templates: every template declares the key set its version's schema accepts", () => {
  /**
   * The test that would have caught the defect this plan fixes.
   *
   * The output schema used to be keyed on job kind alone, with no version
   * dimension — so widening a shape in place silently made every older
   * template's response invalid: three retries and an escalated claim per
   * generation, for every project pinned to that older template, presenting
   * as a model-compliance problem. This assertion makes the two halves —
   * what a template ASKS FOR and what the boundary ACCEPTS — provably the
   * same statement, rather than two statements that happen to agree today.
   */
  function acceptedKeys(promptVersion: string): string[] {
    // The selector is the source of truth on purpose: reproducing the
    // version→shape decision here would let the test agree with a wrong
    // selector. Both branches are objects carrying `.shape`; the widened
    // return type is what hides it.
    const schema = rubricOutputSchemaFor(promptVersion) as unknown as {
      shape: Record<string, unknown>;
    };
    return Object.keys(schema.shape).sort();
  }

  it.each(rubricTemplates())("%s", (version, templatePath) => {
    expect(declaredKeys(templatePath).sort()).toEqual(acceptedKeys(version));
  });

  it("pins which side of the partition each shipped version falls on", () => {
    expect(acceptedKeys("1.0.0")).toEqual(["calibration_result", "reasoning"]);
    expect(acceptedKeys("1.1.0")).toEqual(["calibration_result", "reasoning"]);
    expect(acceptedKeys("1.2.0")).toEqual([
      "calibration_result",
      "caveat",
      "reasoning_plain",
      "reasoning_technical",
    ]);
    expect(acceptedKeys("1.2.0-plain-first")).toEqual(acceptedKeys("1.2.0"));
  });
});

describe("rubric v1.2.0: the two ordering variants differ in exactly one thing", () => {
  // PROMPT-05 measures which ordering moves the verdicts less against the
  // v1.1.0 baseline. If the variants differ in anything besides field order,
  // that measurement has two variables in it and its result is
  // uninterpretable.
  const orderingA = path.join(rubricDir, "v1.2.0.md");
  const orderingB = path.join(rubricDir, "v1.2.0-plain-first.md");

  it("is byte-identical outside the fenced output block", () => {
    const a = outputBlock(orderingA);
    const b = outputBlock(orderingB);
    expect(b.before).toBe(a.before);
    expect(b.after).toBe(a.after);
  });

  it("declares the same keys in a different order", () => {
    const a = declaredKeys(orderingA);
    const b = declaredKeys(orderingB);
    expect([...b].sort()).toEqual([...a].sort());
    expect(b).not.toEqual(a);
    expect(a).toEqual([
      "calibration_result",
      "reasoning_technical",
      "caveat",
      "reasoning_plain",
    ]);
    expect(b).toEqual([
      "calibration_result",
      "reasoning_plain",
      "caveat",
      "reasoning_technical",
    ]);
  });
});

describe("rubric v1.2.0: the German rule names are stated verbatim", () => {
  // The rule-name table lives in `lib/adapters/schema/plain-contract.ts` and
  // the same literals live in the template text. The SHA pin covers the
  // template bytes but not that duplication, so this is what closes it: a
  // renamed rule in the table without a template edit fails here.
  it.each(["v1.2.0.md", "v1.2.0-plain-first.md"])("%s", (name) => {
    const text = fs.readFileSync(path.join(rubricDir, name), "utf8");
    for (const ruleName of Object.values(GERMAN_RULE_NAMES)) {
      expect(text, `${name} must state "${ruleName}" verbatim`).toContain(
        ruleName,
      );
    }
  });
});
