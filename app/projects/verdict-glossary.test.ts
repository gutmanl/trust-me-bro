import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  CalibrationResult,
  ClaimType,
  RelationType,
  SourceType,
  SupportDegree,
} from "@/lib/register";
import { CALIBRATION_LABELS } from "./status-labels";
import {
  substituteVerdictProse,
  VERDICT_PROSE,
  type RubricRuleKey,
  type VerdictProseEvidence,
} from "./verdict-glossary";

/**
 * The fixture corpus measured ZERO occurrences of any substitutable token —
 * `tests/corpus/llm/` holds cassettes for extraction and reference parsing
 * only, and every hand-written fixture reasoning is short German prose. And
 * `app/**` sits outside `coverage.include`, so there is no ratchet pressure
 * either. These tests ARE the corpus: a behaviour with no case here is an
 * untested behaviour, permanently.
 */

const NO_EVIDENCE: VerdictProseEvidence[] = [];

/** Owned by `reasoning-paragraphs.ts`; mirrored here so a fourth marker
 * added there without checking the glossary side fails on both sides. */
const ROLE_MARKERS = [
  "Einfach gesagt: der Beleg passt.",
  "Jedoch: nur für n = 120.",
  "Technisch: die Rubrik verlangt zwei Quellen.",
];

function idempotent(text: string, evidence: VerdictProseEvidence[]): void {
  const once = substituteVerdictProse(text, evidence);
  expect(substituteVerdictProse(once, evidence)).toBe(once);
}

describe("substituteVerdictProse — closed vocabularies", () => {
  it("renders a whole stored reasoning in German", () => {
    const stored =
      "Der Beleg ist eine peer_reviewed_publication und supports die " +
      "comparative_statement.\n\nJedoch: die Formulierung wurde als " +
      "weakened bewertet.";
    expect(substituteVerdictProse(stored, NO_EVIDENCE)).toBe(
      "Der Beleg ist eine begutachtete Publikation und stützt die " +
        "Vergleichsaussage.\n\nJedoch: die Formulierung wurde als " +
        "abgeschwächt bewertet.",
    );
    idempotent(stored, NO_EVIDENCE);
  });

  it("never eats a longer key with a shorter one", () => {
    const relation = substituteVerdictProse(
      "Der Auszug partially_supports die Aussage.",
      NO_EVIDENCE,
    );
    expect(relation).toBe("Der Auszug stützt teilweise die Aussage.");
    expect(relation).not.toContain("partially_");

    const degree = substituteVerdictProse(
      "Die Aussage gilt als partially_supported.",
      NO_EVIDENCE,
    );
    expect(degree).toBe("Die Aussage gilt als teilweise gestützt.");
    expect(degree).not.toContain("partially_");
  });

  it("leaves a token that is only part of a longer word alone", () => {
    // The underscore inside the boundary class is what stops `supports`
    // from being eaten out of `pre_supports`.
    for (const text of ["Die unsupportedness bleibt.", "Ein pre_supports."]) {
      expect(substituteVerdictProse(text, NO_EVIDENCE)).toBe(text);
    }
  });

  it("is a no-op on each role-marker literal", () => {
    for (const paragraph of ROLE_MARKERS) {
      expect(substituteVerdictProse(paragraph, NO_EVIDENCE)).toBe(paragraph);
    }
  });
});

describe("substituteVerdictProse — quote safety", () => {
  it("keeps a quoted span byte-identical", () => {
    const stored =
      "Der Auszug „the tool supports incremental builds“ supports die " +
      "Aussage.";
    expect(substituteVerdictProse(stored, NO_EVIDENCE)).toBe(
      "Der Auszug „the tool supports incremental builds“ stützt die " +
        "Aussage.",
    );
    idempotent(stored, NO_EVIDENCE);
  });

  it("refuses entirely on an unterminated quotation", () => {
    // Partial substitution would be the worst outcome: it rewrites some of
    // a quotation whose boundaries are unknown.
    const stored = "Der Auszug „the tool supports builds und supports es.";
    expect(substituteVerdictProse(stored, NO_EVIDENCE)).toBe(stored);
  });

  it("refuses entirely on a nested directional opener", () => {
    const stored = "Er schreibt „er sagte „supports“ dazu“ und supports es.";
    expect(substituteVerdictProse(stored, NO_EVIDENCE)).toBe(stored);
  });

  it("refuses entirely above the quoted-run cap", () => {
    const runs = Array.from({ length: 9 }, (_, index) => `„R${index}“`).join(
      " ",
    );
    const stored = `${runs} supports die Aussage.`;
    expect(substituteVerdictProse(stored, NO_EVIDENCE)).toBe(stored);
  });

  it("treats an apostrophe inside a quoted run as content", () => {
    const stored = "Der Auszug „the tool’s builds“ supports die Aussage.";
    expect(substituteVerdictProse(stored, NO_EVIDENCE)).toBe(
      "Der Auszug „the tool’s builds“ stützt die Aussage.",
    );
  });

  it("refuses on an unpaired apostrophe in unquoted prose", () => {
    // The deliberate cost of following the quote vocabulary literally: a
    // typographic apostrophe outside any run opens a single-family run that
    // never closes. Refusal is the safe direction — see the module comment.
    const stored = "Meyers’ Studie supports die comparative_statement.";
    expect(substituteVerdictProse(stored, NO_EVIDENCE)).toBe(stored);
  });

  it("protects a span equal to one of this claim's excerpts", () => {
    const evidence: VerdictProseEvidence[] = [
      {
        id: "ev_0001",
        number: 7,
        citation: "Meyer et al. (2025), IEEE TSE",
        verbatimExcerpt: "the tool supports incremental builds",
      },
    ];
    const stored =
      "Der Wortlaut the tool supports incremental builds — der Auszug " +
      "supports die Aussage.";
    expect(substituteVerdictProse(stored, evidence)).toBe(
      "Der Wortlaut the tool supports incremental builds — der Auszug " +
        "stützt die Aussage.",
    );
    idempotent(stored, evidence);
  });
});

describe("substituteVerdictProse — evidence-id referents", () => {
  const MEYER = "Meyer et al. (2025), IEEE TSE";
  const evidenceOf = (
    overrides: Partial<VerdictProseEvidence> = {},
  ): VerdictProseEvidence[] => [
    {
      id: "ev_0001",
      number: 7,
      citation: MEYER,
      verbatimExcerpt: "the tool builds incrementally",
      ...overrides,
    },
  ];

  it("resolves an id through THIS claim's evidence", () => {
    expect(
      substituteVerdictProse("Wie in ev_0001 gezeigt.", evidenceOf()),
    ).toBe(`Wie in [7] (${MEYER}) gezeigt.`);
  });

  it("leaves an id that is not this claim's verbatim", () => {
    // A wrong bracket number is worse than a raw token: it would point the
    // reviewer at another claim's evidence.
    expect(
      substituteVerdictProse("Wie in ev_0042 gezeigt.", evidenceOf()),
    ).toBe("Wie in ev_0042 gezeigt.");
  });

  it("renders the bracket alone when no citation is known", () => {
    expect(
      substituteVerdictProse(
        "Wie in ev_0001 gezeigt.",
        evidenceOf({ citation: undefined }),
      ),
    ).toBe("Wie in [7] gezeigt.");
  });

  it("renders the citation alone when no number is known", () => {
    // Losing the bracket loses only the affordance; the citation carries
    // the meaning.
    expect(
      substituteVerdictProse(
        "Wie in ev_0001 gezeigt.",
        evidenceOf({ number: undefined }),
      ),
    ).toBe(`Wie in (${MEYER}) gezeigt.`);
  });

  it("leaves the id verbatim when neither is known", () => {
    expect(
      substituteVerdictProse(
        "Wie in ev_0001 gezeigt.",
        evidenceOf({ number: undefined, citation: undefined }),
      ),
    ).toBe("Wie in ev_0001 gezeigt.");
  });

  it("keeps the referent stable when an earlier claim is inserted", () => {
    // buildBriefingViewModel numbers evidence GLOBALLY in deterministic
    // claim order, so inserting a claim earlier in that order shifts every
    // later bracket. An immutable, hash-chained sentence written in March
    // must not name a different source today, and two exports taken at
    // different times must not disagree. This case fails by construction if
    // bare bracket numbers are ever chosen as the referent.
    const before = substituteVerdictProse(
      "Wie in ev_0001 gezeigt.",
      evidenceOf({ number: 7 }),
    );
    const after = substituteVerdictProse(
      "Wie in ev_0001 gezeigt.",
      evidenceOf({ number: 24 }),
    );
    expect(before).toContain(MEYER);
    expect(after).toContain(MEYER);
    expect(before.replace("[7]", "")).toBe(after.replace("[24]", ""));
  });

  it("does not resolve an id inside a quoted run", () => {
    const stored = "Der Autor schreibt „siehe ev_0001“ dazu.";
    expect(substituteVerdictProse(stored, evidenceOf())).toBe(stored);
  });

  it("does not resolve any id when the quote structure is refused", () => {
    const stored = "Der Autor schreibt „siehe ev_0001 dazu.";
    expect(substituteVerdictProse(stored, evidenceOf())).toBe(stored);
  });

  it("stays idempotent when the citation carries quote marks", () => {
    // Substitution happens only OUTSIDE protected runs, so an inserted
    // citation lands at a run boundary. An EVEN number of inserted marks
    // forms a self-contained pair and leaves every later pairing unchanged;
    // an ODD number makes some run unterminated on the second pass, and
    // refusal returns the input unchanged. Either way pass two is identity.
    for (const citation of [
      "Meyer, „Belege“ (2025)",
      "Meyer, „Belege (2025)",
    ]) {
      idempotent("Wie in ev_0001 gezeigt.", evidenceOf({ citation }));
    }
  });
});

// Enumerated as typed const arrays, exactly like verdict-labels.test.ts: a
// new enum member fails to COMPILE here instead of slipping through as an
// unsubstituted token. `app/**` sits outside `coverage.include`, so this is
// the only exhaustiveness pressure this module will ever get.
const CLAIM_TYPES: ClaimType[] = [
  "quantitative_finding",
  "comparative_statement",
  "effectiveness_statement",
  "recommendation",
];
const RELATIONS: RelationType[] = [
  "supports",
  "partially_supports",
  "contradicts",
  "not_relevant",
];
const SUPPORT_DEGREES: SupportDegree[] = [
  "supported",
  "partially_supported",
  "unsupported",
  "uncertain",
];
const CALIBRATIONS: CalibrationResult[] = [
  "licensed",
  "weakened",
  "pending_adjudication",
];
const SOURCE_TYPES: SourceType[] = [
  "peer_reviewed_publication",
  "preprint",
  "grey_literature",
  "vendor_documentation",
];
const RUBRIC_RULE_KEYS: RubricRuleKey[] = [
  "min_pertinent_sources",
  "required_source_types_any",
  "min_source_type_diversity",
  "insufficient_if_only",
];

describe("VERDICT_PROSE", () => {
  it("covers the closed-vocabulary union exactly", () => {
    const union = [
      ...CLAIM_TYPES,
      ...RELATIONS,
      ...SUPPORT_DEGREES,
      ...CALIBRATIONS,
      ...SOURCE_TYPES,
      ...RUBRIC_RULE_KEYS,
    ];
    // pending_adjudication is a member of BOTH ClaimStatus and
    // CalibrationResult (enums.ts documents that as deliberate); it enters
    // this map through CalibrationResult alone, once.
    expect(Object.keys(VERDICT_PROSE).sort()).toEqual([...union].sort());
    expect(union).toHaveLength(23);
  });

  it("labels every key in non-empty German", () => {
    for (const value of Object.values(VERDICT_PROSE)) {
      expect(value.trim()).toBe(value);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("has no value that is itself a key", () => {
    // The second half of the idempotency guarantee — the first half is the
    // single-pass alternation. If a German value were a key, a second pass
    // over already-rendered prose would substitute it again.
    for (const value of Object.values(VERDICT_PROSE)) {
      expect(value in VERDICT_PROSE).toBe(false);
    }
  });

  it("is not the badge label map", () => {
    // The grammar reason, which is the whole reason two maps exist:
    // "abgeschwächt" is a participle that sits in a sentence, "abschwächen"
    // is an infinitive that cannot ("Das Ergebnis ist abschwächen."). This
    // assertion is what a future "DRY these two maps" refactor trips over,
    // which is exactly what it is for.
    expect(VERDICT_PROSE.weakened).toBe("abgeschwächt");
    expect(CALIBRATION_LABELS.weakened).toBe("abschwächen");
    expect(VERDICT_PROSE.weakened).not.toBe(CALIBRATION_LABELS.weakened);
  });
});

describe("placement", () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );

  function sourceFiles(dir: string): string[] {
    const absolute = path.join(repoRoot, dir);
    return fs
      .readdirSync(absolute, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(absolute, name));
  }

  it("is unreachable from the domain core", () => {
    // v1.0's Key Decisions record: never touch formatCitationItem globally
    // for display needs, because it also feeds LLM prompt input and the
    // persisted briefing footnote. The glossary is the same hazard with a
    // new name — proposeRepair builds claim_json/evidence_json from register
    // data that must stay machine-shaped, and a .tmb bundle must reproduce
    // the register byte for byte. Placement in app/ makes the leak
    // structurally impossible; this asserts nobody moved it.
    for (const file of [...sourceFiles("lib"), ...sourceFiles("cli")]) {
      expect(
        fs.readFileSync(file, "utf8"),
        `${file} references the display glossary`,
      ).not.toContain("verdict-glossary");
    }
  });

  it("is absent from the pipeline barrel", () => {
    // The barrel is where a display-only export would first become
    // reachable from lib/ and from the export path.
    expect(
      fs.readFileSync(path.join(repoRoot, "lib/pipeline/index.ts"), "utf8"),
    ).not.toContain("verdict-glossary");
  });

  // No export round-trip assertion here on purpose: render-briefing.ts
  // renders status, relation and evidence numbers and NO reasoning at all,
  // so there is no rendered prose in briefing.md or a .tmb bundle for the
  // glossary to leak into. Unreachability from lib/** is the assertion that
  // actually holds — and it keeps holding if render-briefing.ts ever grows a
  // reasoning section.
});
