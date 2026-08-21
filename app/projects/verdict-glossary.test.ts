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
