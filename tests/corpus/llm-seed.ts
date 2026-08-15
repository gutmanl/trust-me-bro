/**
 * Authored LLM answers for the scenarios, used only until real ones are
 * recorded (see `ReplayBackendOptions.seed`).
 *
 * These are shaped like a model's answer to the specific briefing in
 * `scenarios.ts` — the same source ids, the same quoted wording — because
 * the pipeline behaviour under test depends on the *content* of the answer,
 * not merely its schema. Every one of them is schema-validated by the
 * orchestrator on the way through, exactly as a real answer is.
 *
 * The adversarial answers live here too, and they are the reason a seed tier
 * is worth having at all: no amount of recording produces an extraction that
 * cites a source id which was never captured on demand. That answer has to
 * be authored, and a spec that uses it says so at its call site.
 */
import type { JobKind } from "../../lib/adapters/core/jobs";
import {
  CITATION_WITHOUT_IDENTIFIER,
  QUOTE_ABSENT,
  QUOTE_PRESENT,
} from "./scenarios";

/** Source id the extraction seeds attribute their evidence to. Minted by the
 * register at capture time, so specs pass the id they actually got. */
export function extractionSeed(sourceId: string): Partial<{
  [K in JobKind]: unknown;
}> {
  return {
    extraction: {
      claims: [
        {
          text: "Ein manipulationssicheres Register verkürzt die mediane Rekonstruktionszeit einer Prüfentscheidung von 42 auf 19 Minuten.",
          claim_type: "quantitative_finding",
          // Must occur verbatim in the briefing paragraph, or the claim
          // lands unanchored — the pipeline resolves the paragraph by
          // searching for this phrase.
          anchor_quote: "Die mediane Rekonstruktionszeit sank von 42",
          evidence: [
            {
              source_id: sourceId,
              locator: { page: 1 },
              verbatim_excerpt: QUOTE_PRESENT,
            },
          ],
        },
      ],
      additional_evidence: [],
    },
  };
}

/**
 * Extraction that quotes wording the frozen document does not contain — the
 * misquote stage 1 must catch deterministically, with no model involved.
 */
export function misquotingExtractionSeed(sourceId: string): Partial<{
  [K in JobKind]: unknown;
}> {
  return {
    extraction: {
      claims: [
        {
          text: "Audit-Trails senken den Rekonstruktionsaufwand um über achtzig Prozent.",
          claim_type: "quantitative_finding",
          anchor_quote: "Die mediane Rekonstruktionszeit sank von 42",
          evidence: [
            {
              source_id: sourceId,
              locator: { page: 1 },
              verbatim_excerpt: QUOTE_ABSENT,
            },
          ],
        },
      ],
      additional_evidence: [],
    },
  };
}

/**
 * Extraction citing a source id that is not in the register — the
 * "hallucinated reference" the salvage path in `apply-extraction-output.ts`
 * filters out, keeping the claim and dropping only the invented evidence.
 */
export const HALLUCINATED_SOURCE_EXTRACTION = {
  extraction: {
    claims: [
      {
        text: "Evidenzschranken verhindern die Aufnahme unbelegter Aussagen.",
        claim_type: "effectiveness_statement",
        anchor_quote: "Evidenzschranken für automatisierte",
        evidence: [
          {
            source_id: "src_does_not_exist",
            locator: { page: 7 },
            verbatim_excerpt: "evidence gates reject unsupported statements",
          },
        ],
      },
    ],
    additional_evidence: [],
  },
} satisfies Partial<{ [K in JobKind]: unknown }>;

/**
 * Reference parse over the scenario briefing.
 *
 * Exactly one reference, and that is the realistic answer rather than a
 * thin one: the scan hands the model the identifier spans the regex channel
 * already found (`already_detected`) and drops any re-report of a paragraph
 * that carries one. The model's job is the citation nobody could pattern-
 * match — prose naming an author and a year and nothing else. That citation
 * is what reaches Crossref's title search, so this seed is what makes the
 * title-resolution branch run at all.
 */
export const REFERENCE_PARSE_SEED = {
  reference_parse: {
    references: [
      {
        raw_text: CITATION_WITHOUT_IDENTIFIER.rawText,
        authors: [...CITATION_WITHOUT_IDENTIFIER.authors],
        year: CITATION_WITHOUT_IDENTIFIER.year,
        title: CITATION_WITHOUT_IDENTIFIER.title,
      },
    ],
  },
} satisfies Partial<{ [K in JobKind]: unknown }>;

/** Stage-2 answers, for the specs that walk past the existence check. */
export const JUDGMENT_SEED = {
  attribution: {
    relation_type: "supports",
    confidence: 0.91,
    reasoning:
      "Der Auszug nennt denselben Zahlenwert und dieselbe Richtung wie der Claim.",
  },
  rubric: {
    calibration_result: "licensed",
    reasoning: "Die Mindestevidenz der Rubrik liegt vor.",
  },
} satisfies Partial<{ [K in JobKind]: unknown }>;
