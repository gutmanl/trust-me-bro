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
  SOURCE_MISATTRIBUTED_INLINE,
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
          text: "Ein manipulationssicheres Register macht den Zustand eines eingesetzten Systems rekonstruierbar.",
          claim_type: "quantitative_finding",
          // Must occur verbatim in the briefing paragraph, or the claim
          // lands unanchored — the pipeline resolves the paragraph by
          // searching for this phrase.
          anchor_quote: "Prüfende können feststellen, was zu einem",
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
          anchor_quote: "Prüfende können feststellen, was zu einem",
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
 * Reference parse over the scenario briefing, as prompt v1.1.0 asks for it.
 *
 * Two kinds of reference, because v1.1.0 wants both. The citation nobody
 * could pattern-match — prose naming an author and a year and nothing else —
 * is what reaches Crossref's title search, so it is what makes the
 * title-resolution branch run at all. Alongside it, the citation the regex
 * channel DID find, reported with the bibliographic detail the regex channel
 * cannot read and its identifier echoed back. v1.0.0 told the model to stay
 * silent about that one, which is why an inline citation reached the
 * identity cross-check with no title and the guard never ran.
 *
 * Only the inline one is reported here, not the footnote citations: their
 * titles already reach the seed through the footnote-marker path, and a
 * model that read the briefing would have nothing to add. The point of the
 * seed is to answer the way the prompt asks, not to pad.
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
      {
        // Title and identifier only, because that is all the sentence
        // states. `authors`/`year` are deliberately absent: v1.1.0 tells the
        // model never to fill a field it cannot read off the text, and here
        // the distinction decides the outcome. The cross-check scores title,
        // year and author together, so authors and a year recalled from the
        // identifier would agree with what that identifier resolves to and
        // lift a genuine misattribution back over the threshold — the check
        // would confirm the hallucination instead of catching it.
        raw_text:
          `Zur automatisierten Beschaffung von Belegstellen liegt eine ` +
          `Übersicht vor (${SOURCE_MISATTRIBUTED_INLINE.citedTitle}, ` +
          `doi:${SOURCE_MISATTRIBUTED_INLINE.identifier}).`,
        authors: [],
        title: SOURCE_MISATTRIBUTED_INLINE.citedTitle,
        doi: SOURCE_MISATTRIBUTED_INLINE.canonical,
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
      "Der Auszug beschreibt dieselbe Eigenschaft wie der Claim: den " +
      "rekonstruierbaren Zustand des eingesetzten Systems.",
  },
  rubric: {
    calibration_result: "licensed",
    reasoning: "Die Mindestbelege des Bewertungsschemas liegen vor.",
  },
} satisfies Partial<{ [K in JobKind]: unknown }>;
