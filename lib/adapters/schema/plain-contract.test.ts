import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  CalibrationResult,
  ClaimType,
  RelationType,
  SourceType,
  SupportDegree,
} from "../../register";
import {
  FORBIDDEN_TOKENS,
  GERMAN_RULE_NAMES,
  JOINED_MAX_CHARS,
  PLAIN_MAX_CHARS,
  PLAIN_VERDICT_PHRASE,
  plainLanguageContract,
} from "./plain-contract";
import { RubricOutput } from "./rubric";

/**
 * The clause-level table of the plain-language contract (PROMPT-01,
 * PROMPT-02): one REJECTING and one ACCEPTING row per clause, phrased as a
 * patch over a single valid base object so a reader can see exactly which
 * field each row perturbs.
 *
 * `validate.test.ts` carries the same contract's BOUNDARY-level rows — that
 * every rejection surfaces as an `AdapterValidationError`, and that the
 * accepted shape is partitioned by prompt version. This file is about the
 * clauses; that one is about the boundary.
 */

const RULE_NAME = GERMAN_RULE_NAMES.quantitative_finding;

/** Filler carrying no digits, no enum token and no role marker. */
const FILLER = "Die Aussage bleibt im Rahmen der geprueften Belege. ";

function plainOfLength(length: number): string {
  return (`${PLAIN_VERDICT_PHRASE.licensed} ` + FILLER.repeat(30)).slice(
    0,
    length,
  );
}

function technicalOfLength(length: number): string {
  const head = `${RULE_NAME} ist erfuellt. `;
  return (head + FILLER.repeat(40)).slice(0, Math.max(length, head.length));
}

const base = {
  calibration_result: "licensed",
  reasoning_plain:
    `${PLAIN_VERDICT_PHRASE.licensed} Eine begutachtete Studie deckt die ` +
    "Aussage im gleichen Kontext ab.",
  caveat: null as string | null,
  reasoning_technical:
    `${RULE_NAME} verlangt eine begutachtete Studie mit passendem Kontext; ` +
    "eine solche liegt vor und deckt die Aussage in ihrem Kontext ab.",
};

function accepts(patch: Record<string, unknown>): boolean {
  return RubricOutput.safeParse({ ...base, ...patch }).success;
}

function issuesFor(patch: Record<string, unknown>): string[] {
  const result = RubricOutput.safeParse({ ...base, ...patch });
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
}

type Row = [label: string, patch: Record<string, unknown>, accepted: boolean];

const rows: Row[] = [
  ["the untouched base object", {}, true],

  // Forbidden English enum tokens — §6.1.
  [
    "a bare enum spelling in the plain layer",
    { reasoning_plain: `${base.reasoning_plain} Die Quelle ist ein preprint.` },
    false,
  ],
  [
    "the capitalised German noun form of an enum spelling",
    { reasoning_plain: `${base.reasoning_plain} Die Quelle ist ein Preprint.` },
    true,
  ],
  [
    "a bare enum spelling in the caveat",
    { caveat: "die Quelle ist nur ein preprint." },
    false,
  ],
  [
    "a caveat free of enum spellings",
    { caveat: "die Stichprobe ist klein." },
    true,
  ],

  // Length clauses — §6.4.
  [
    "a plain layer of exactly the cap",
    {
      reasoning_plain: plainOfLength(PLAIN_MAX_CHARS),
      reasoning_technical: technicalOfLength(PLAIN_MAX_CHARS + 40),
    },
    true,
  ],
  [
    "a plain layer one character over the cap",
    {
      reasoning_plain: plainOfLength(PLAIN_MAX_CHARS + 1),
      reasoning_technical: technicalOfLength(PLAIN_MAX_CHARS + 80),
    },
    false,
  ],
  [
    "a plain layer longer than its technical layer, both under the cap",
    {
      reasoning_plain: plainOfLength(200),
      reasoning_technical: technicalOfLength(120),
    },
    false,
  ],
  [
    "a plain layer exactly as long as its technical layer",
    {
      reasoning_plain: plainOfLength(200),
      reasoning_technical: technicalOfLength(200),
    },
    true,
  ],
  [
    "three fields exceeding the joined cap together",
    {
      reasoning_plain: plainOfLength(PLAIN_MAX_CHARS),
      caveat: FILLER.repeat(10).slice(0, 300),
      reasoning_technical: technicalOfLength(JOINED_MAX_CHARS),
    },
    false,
  ],

  // Number containment — §6.3, one direction only.
  [
    "a decimal written with a comma in plain and a dot in technical",
    {
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Der Faktor liegt bei 3,5.`,
      reasoning_technical: `${RULE_NAME} ist erfuellt; der Faktor liegt bei 3.5 laut Studie.`,
    },
    true,
  ],
  [
    "a two-decimal form in plain against a one-decimal form in technical",
    {
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Der Faktor liegt bei 3,50.`,
      reasoning_technical: `${RULE_NAME} ist erfuellt; der Faktor liegt bei 3,5 laut Studie.`,
    },
    false,
  ],
  [
    "a thousands-grouped number matched by the same grouped number",
    {
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Es wurden 1.000 Faelle geprueft.`,
      reasoning_technical: `${RULE_NAME} ist erfuellt; die Studie prueft 1.000 Faelle im Kontext.`,
    },
    true,
  ],
  [
    "a thousands-grouped number matched only by its parts",
    {
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Es wurden 1.000 Faelle geprueft.`,
      reasoning_technical: `${RULE_NAME} ist erfuellt; die Studie prueft 1 mal 000 Faelle.`,
    },
    false,
  ],
  [
    "a percentage in plain matched by the bare number in technical",
    {
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Die Zeit sank um 55 %.`,
      reasoning_technical: `${RULE_NAME} ist erfuellt; die Studie berichtet einen Rueckgang von 55 Prozent.`,
    },
    true,
  ],
  [
    "a four-digit year in plain absent from technical (years are NOT exempt)",
    {
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Die Studie stammt aus 2025.`,
      reasoning_technical: `${RULE_NAME} ist erfuellt; die Studie passt im Kontext.`,
    },
    false,
  ],
  [
    "a plain layer with no digits at all (vacuous containment)",
    {
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Die Belege tragen die Aussage.`,
      reasoning_technical: `${RULE_NAME} ist erfuellt; 2 Quellen aus 2025 mit 55 Prozent Effekt.`,
    },
    true,
  ],
  [
    "a technical layer carrying numbers the plain layer omits (compression)",
    {
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Die Zeit sank um 55 %.`,
      reasoning_technical: `${RULE_NAME} ist erfuellt; 55 Prozent bei 1.000 Faellen aus 2025.`,
    },
    true,
  ],
  [
    "the same numbers named in a different order (a multiset, not a sequence)",
    {
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Es sind 55 und 42 Punkte.`,
      reasoning_technical: `${RULE_NAME} ist erfuellt; gemessen wurden 42 und dann 55 Punkte.`,
    },
    true,
  ],

  // The fixed verdict slot-frame — P-1 mitigation 3.
  [
    "a plain layer not beginning with the mapped verdict phrase",
    { reasoning_plain: "Alles in Ordnung, die Belege tragen die Aussage." },
    false,
  ],
  [
    "a plain layer beginning with a DIFFERENT verdict's phrase",
    {
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.weakened} Die Belege tragen die Aussage.`,
    },
    false,
  ],
  [
    "the phrase matching the object's own verdict",
    {
      calibration_result: "weakened",
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.weakened} Die Belege tragen weniger als behauptet.`,
    },
    true,
  ],

  // The German rule-name anchor — §6.2.
  [
    "a technical layer naming none of the four German rule names",
    {
      reasoning_technical:
        "Die Belege genuegen dem Bewertungsschema in diesem Kontext.",
    },
    false,
  ],
  [
    "a technical layer naming another of the four rule names verbatim",
    {
      reasoning_technical:
        `${GERMAN_RULE_NAMES.recommendation} ist erfuellt; mehrere ` +
        "Quellenarten liegen vor und keine davon ist blosse Herstellerdoku.",
    },
    true,
  ],

  // Structural clauses — §5.3 / §6.4.
  [
    "a blank line inside the plain layer",
    {
      reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed}\n\nDie Belege tragen.`,
    },
    false,
  ],
  [
    "a blank line inside the caveat",
    { caveat: "die Studie ist klein.\n\nUnd alt." },
    false,
  ],
  [
    "a blank line inside the technical layer",
    { reasoning_technical: `${RULE_NAME} ist erfuellt.\n\nZweiter Absatz.` },
    false,
  ],
  [
    "a plain layer already carrying its role marker",
    {
      reasoning_plain: `Einfach gesagt: ${PLAIN_VERDICT_PHRASE.licensed} Die Belege tragen.`,
    },
    false,
  ],
  [
    "a caveat already carrying its role marker",
    { caveat: "Jedoch: die Studie ist klein." },
    false,
  ],
  [
    "a technical layer already carrying its role marker",
    { reasoning_technical: `Technisch: ${RULE_NAME} ist erfuellt.` },
    false,
  ],

  // The caveat's three states.
  ["an empty-string caveat", { caveat: "" }, false],
  ["a null caveat", { caveat: null }, true],

  // Display-tier referents in a generated layer — §6.1.
  [
    "an internal evidence id in the plain layer",
    { reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Siehe ev_0001.` },
    false,
  ],
  [
    "an internal claim id in the plain layer",
    { reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Siehe clm_0001.` },
    false,
  ],
  [
    "an internal source id in the plain layer",
    { reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Siehe src_meyer.` },
    false,
  ],
  [
    "a bracket citation in the plain layer",
    { reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} Siehe [3].` },
    false,
  ],
  [
    "an internal id in the caveat",
    { caveat: "der Beleg ev_0002 ist schwach." },
    false,
  ],
];

describe("plainLanguageContract clauses", () => {
  it.each(rows)("%s", (_label, patch, accepted) => {
    expect(accepts(patch)).toBe(accepted);
  });

  it("names the offending enum token in the issue message", () => {
    expect(
      issuesFor({
        reasoning_plain: `${base.reasoning_plain} Die Quelle ist ein preprint.`,
      }).join(" "),
    ).toContain('"preprint"');
  });

  it("names the LONGEST match, not the shorter token nested inside it", () => {
    // "partially_supports".includes("supports") — the message is what the
    // model reads on retry, so naming `supports` would send it looking for a
    // token that is not in its text.
    const messages = issuesFor({
      reasoning_plain: `${base.reasoning_plain} Der Beleg gilt als partially_supports.`,
    }).join(" ");
    expect(messages).toContain('"partially_supports"');
    expect(messages).not.toContain('"supports"');
  });

  it("rejects a response omitting the caveat key entirely", () => {
    const { caveat: _caveat, ...withoutCaveat } = base;
    expect(RubricOutput.safeParse(withoutCaveat).success).toBe(false);
  });
});

describe("the derived vocabulary and the fixed tables", () => {
  it("equals the union of the five closed register enumerations", () => {
    // Phase 02's display glossary asserts the same union from the display
    // side. Both derive from lib/register/schema/enums.ts, so the two lists
    // can differ in scope but never in membership. ClaimStatus is excluded
    // on both sides: it is never shown to the model.
    expect([...FORBIDDEN_TOKENS].sort()).toEqual(
      [
        ...ClaimType.options,
        ...RelationType.options,
        ...SupportDegree.options,
        ...CalibrationResult.options,
        ...SourceType.options,
      ].sort(),
    );
  });

  it("covers every CalibrationResult and RelationType value with a verdict phrase", () => {
    for (const value of [
      ...CalibrationResult.options,
      ...RelationType.options,
    ]) {
      expect(PLAIN_VERDICT_PHRASE[value]?.length).toBeGreaterThan(0);
    }
  });

  it("covers every ClaimType with a German rule name", () => {
    for (const value of ClaimType.options) {
      expect(GERMAN_RULE_NAMES[value]?.length).toBeGreaterThan(0);
    }
  });

  it("keeps both fixed tables free of the forbidden-token vocabulary", () => {
    // It cannot collide today — the detector is lowercase-ASCII-anchored and
    // the phrases are capitalised German — but the point of asserting it is
    // that a future edit to either table must not silently break the other.
    for (const phrase of Object.values(PLAIN_VERDICT_PHRASE)) {
      expect(
        issuesFor({
          calibration_result: "licensed",
          reasoning_plain: `${PLAIN_VERDICT_PHRASE.licensed} ${phrase}`,
        }).join(" "),
      ).not.toContain("Fachbegriff");
    }
    for (const name of Object.values(GERMAN_RULE_NAMES)) {
      expect(
        issuesFor({ caveat: `die ${name} greift nur knapp.` }).join(" "),
      ).not.toContain("Fachbegriff");
    }
  });
});

describe("the contract's parameterisation (the seam 03-02 uses)", () => {
  // The rule-name anchor is rubric-only: attribution anchors on the excerpt
  // instead, so its arm must be able to switch the clause off. Proving the
  // parameter here keeps 03-02 from discovering it against a live schema.
  const AttributionLike = z
    .strictObject({
      relation_type: RelationType,
      reasoning_plain: z.string().min(1),
      caveat: z.string().min(1).nullable(),
      reasoning_technical: z.string().min(1),
    })
    .check(
      plainLanguageContract({
        verdictOf: (value) => value.relation_type,
        requireRuleName: false,
      }),
    );

  it("accepts a technical layer without a German rule name when the anchor is off", () => {
    expect(
      AttributionLike.safeParse({
        relation_type: "supports",
        reasoning_plain: `${PLAIN_VERDICT_PHRASE.supports} Der Auszug nennt die Kennzahl.`,
        caveat: null,
        reasoning_technical:
          "Der Auszug nennt die entscheidende Formulierung woertlich und in derselben Richtung.",
      }).success,
    ).toBe(true);
  });

  it("still enforces the verdict slot-frame against the relation type", () => {
    expect(
      AttributionLike.safeParse({
        relation_type: "contradicts",
        reasoning_plain: `${PLAIN_VERDICT_PHRASE.supports} Der Auszug nennt die Kennzahl.`,
        caveat: null,
        reasoning_technical:
          "Der Auszug nennt die entscheidende Formulierung woertlich, aber in der Gegenrichtung.",
      }).success,
    ).toBe(false);
  });
});
