import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { exampleInputs } from "../__fixtures__/jobs";
import { attributionOutputSchemaFor } from "../schema/attribution";
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
 * Every block covers BOTH pinnable job kinds. Rubric and attribution are the
 * two kinds whose template version a project pins through its rule file, and
 * an invariant that holds for one and not the other is exactly the asymmetry
 * PROMPT-04 exists to remove.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const promptsDir = path.join(repoRoot, "lib", "adapters", "prompts");
const rubricDir = path.join(promptsDir, "rubric");
const attributionDir = path.join(promptsDir, "attribution");

/** The verdict enum each kind's output shape must declare FIRST. */
const VERDICT_KEY = {
  attribution: "relation_type",
  rubric: "calibration_result",
} as const;
type PinnableKind = keyof typeof VERDICT_KEY;
const PINNABLE_KINDS = ["attribution", "rubric"] as const;

function dirOf(kind: PinnableKind): string {
  return kind === "rubric" ? rubricDir : attributionDir;
}

/**
 * Every template file of one kind on disk, as `[version, absolutePath]`.
 * Iterating the directory rather than listing versions is deliberate: a
 * template added later is covered without anyone remembering to add a row.
 */
function templatesOf(kind: PinnableKind): Array<[string, string]> {
  const dir = dirOf(kind);
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("v") && name.endsWith(".md"))
    .sort()
    .map((name) => [name.slice(1, -3), path.join(dir, name)]);
}

/** Both kinds at once, as `[kind, version, absolutePath]`. */
function allTemplates(): Array<[PinnableKind, string, string]> {
  return PINNABLE_KINDS.flatMap((kind) =>
    templatesOf(kind).map(
      ([version, file]) =>
        [kind, version, file] as [PinnableKind, string, string],
    ),
  );
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

describe("prompt templates: the verdict enum is the first key", () => {
  // The mechanism: a response is decoded left to right, so the verdict token
  // is produced before any prose and prose written afterwards cannot
  // mechanically pull the verdict with it. The property dies the moment
  // someone applies the classic "let it reason before it answers" refactor —
  // which is exactly why the two OLDER versions are asserted here too. The
  // invariant is not new, and a regression in a shipped template is worse
  // than one in a file nobody has run yet.
  it.each(allTemplates())(
    "%s v%s declares its verdict enum first",
    (kind, _version, templatePath) => {
      expect(declaredKeys(templatePath)[0]).toBe(VERDICT_KEY[kind]);
    },
  );
});

describe.each(PINNABLE_KINDS)(
  "%s templates: the placeholder set is stable across versions",
  (kind) => {
    // The PROMPT-06 kill shot. `substitute` is strict in BOTH directions and
    // `buildVars` is keyed on JobKind, not on version — so a single new
    // placeholder in a v1.2.0 template instantly stops v1.0.0 and v1.1.0 from
    // rendering for that kind, which destroys PROMPT-06 for every existing
    // project. This is the easiest available way to break the phase's own
    // headline requirement.
    it("every template of this kind declares the same placeholders", () => {
      const sets = templatesOf(kind).map(([version, templatePath]) => [
        version,
        placeholders(templatePath),
      ]);
      const [, first] = sets[0] as [string, string[]];
      for (const [version, set] of sets as Array<[string, string[]]>) {
        expect(set, `${kind} v${version} placeholder set`).toEqual(first);
      }
    });

    it.each(templatesOf(kind))("renders at %s without throwing", (version) => {
      // A successful strict render IS the assertion that this template's
      // placeholder set equals buildVars' key set for this kind exactly:
      // substitute throws on an unfilled placeholder AND on an unused
      // variable.
      const rendered =
        kind === "rubric"
          ? renderPromptForJob("rubric", exampleInputs.rubric, version)
          : renderPromptForJob(
              "attribution",
              exampleInputs.attribution,
              version,
            );
      expect(rendered.version).toBe(version);
      expect(rendered.text.length).toBeGreaterThan(0);
      expect(rendered.text).not.toMatch(/\{\{[a-z_]+\}\}/);
    });
  },
);

describe("prompt templates: every template declares the key set its version's schema accepts", () => {
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
  function acceptedKeys(kind: PinnableKind, promptVersion: string): string[] {
    // The selector is the source of truth on purpose: reproducing the
    // version→shape decision here would let the test agree with a wrong
    // selector. Both branches are objects carrying `.shape`; the widened
    // return type is what hides it.
    const schema = (kind === "rubric"
      ? rubricOutputSchemaFor(promptVersion)
      : attributionOutputSchemaFor(promptVersion)) as unknown as {
      shape: Record<string, unknown>;
    };
    return Object.keys(schema.shape).sort();
  }

  // This is also the row that turns "the older templates still RENDER" into
  // "the older templates still WORK". A v1.1.0 prompt that renders fine but
  // asks for a response the boundary would reject is a project that resolves
  // cleanly and then fails three attempts per claim and escalates it —
  // PROMPT-06 satisfied in name only. Rendering is half; acceptance is the
  // other half, and it lives in the version dispatch, not in the rule file.
  it.each(allTemplates())("%s v%s", (kind, version, templatePath) => {
    expect(declaredKeys(templatePath).sort()).toEqual(
      acceptedKeys(kind, version),
    );
  });

  it("pins which side of the partition each shipped RUBRIC version falls on", () => {
    const rubricKeys = (version: string) => acceptedKeys("rubric", version);
    expect(rubricKeys("1.0.0")).toEqual(["calibration_result", "reasoning"]);
    expect(rubricKeys("1.1.0")).toEqual(["calibration_result", "reasoning"]);
    expect(rubricKeys("1.2.0")).toEqual([
      "calibration_result",
      "caveat",
      "reasoning_plain",
      "reasoning_technical",
    ]);
    expect(rubricKeys("1.2.0-plain-first")).toEqual(rubricKeys("1.2.0"));
  });

  it("pins which side of the partition each shipped ATTRIBUTION version falls on", () => {
    // 1.0.0 and 1.1.0 land on the FROZEN three-key shape — and 1.1.0 is what
    // every existing project renders today, so this pair is the direct
    // machine statement of PROMPT-06 for the attribution half.
    const attributionKeys = (version: string) =>
      acceptedKeys("attribution", version);
    expect(attributionKeys("1.0.0")).toEqual([
      "confidence",
      "reasoning",
      "relation_type",
    ]);
    expect(attributionKeys("1.1.0")).toEqual([
      "confidence",
      "reasoning",
      "relation_type",
    ]);
    expect(attributionKeys("1.2.0")).toEqual([
      "caveat",
      "confidence",
      "reasoning_plain",
      "reasoning_technical",
      "relation_type",
    ]);
    expect(attributionKeys("1.2.0-plain-first")).toEqual(
      attributionKeys("1.2.0"),
    );
  });
});

/**
 * PROMPT-05 (rubric) and the 03-04 harness (attribution) measure which
 * ordering moves the verdicts less against the v1.1.0 baseline. If the
 * variants differ in anything besides field order, that measurement has two
 * variables in it and its result is uninterpretable. One implementation for
 * both kinds, because a per-kind copy is how the two would drift.
 */
function describeVariantEquivalence(
  kind: PinnableKind,
  orderA: string[],
  orderB: string[],
): void {
  describe(`${kind} v1.2.0: the two ordering variants differ in exactly one thing`, () => {
    const orderingA = path.join(dirOf(kind), "v1.2.0.md");
    const orderingB = path.join(dirOf(kind), "v1.2.0-plain-first.md");

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
      expect(a).toEqual(orderA);
      expect(b).toEqual(orderB);
    });
  });
}

describeVariantEquivalence(
  "rubric",
  ["calibration_result", "reasoning_technical", "caveat", "reasoning_plain"],
  ["calibration_result", "reasoning_plain", "caveat", "reasoning_technical"],
);

describeVariantEquivalence(
  "attribution",
  [
    "relation_type",
    "confidence",
    "reasoning_technical",
    "caveat",
    "reasoning_plain",
  ],
  [
    "relation_type",
    "confidence",
    "reasoning_plain",
    "caveat",
    "reasoning_technical",
  ],
);

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
