import { describe, expect, it } from "vitest";

import {
  substituteVerdictProse,
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
