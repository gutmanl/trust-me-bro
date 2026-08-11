import type { ParsedReference } from "../../../adapters";

/**
 * Drops LLM-parsed references that re-report a citation the regex channel
 * already found by its identifier (reference auto-import).
 *
 * The case, seen on real briefings: a paragraph both links its source inline
 * ("… Quelle: https://…/paper [^1]") — which the DOI/arXiv/URL regex turns
 * into a candidate — AND discusses it in prose ("Harel et al. schreiben: …"),
 * which the LLM extracts as a SEPARATE citation and Crossref then resolves to
 * a DOI. The two describe one work but carry different identifiers (the
 * pasted URL vs. the Crossref DOI), so mergeCandidates — which only collapses
 * identical identifiers — keeps both, and the same paper is suggested twice.
 *
 * A parsed reference is dropped when it carries an identifier span itself, or
 * when (almost) all of its word tokens appear in one already-covered text
 * block. The caller supplies those blocks (run-reference-scan.ts): the
 * briefing paragraphs that carry an inline identifier, AND the footnote
 * definitions already claimed by an inline identifier — so a re-report is
 * caught whether the model copied the prose or the footnote entry, which live
 * in different paragraphs joined only by the marker.
 *
 * Word-token containment, not substring, because the model reformats what it
 * copies (typographic vs. straight quotes, em-dashes, dropped parentheticals).
 * A genuinely different citation — sharing only incidental words — keeps its
 * distinctive author/title tokens and survives.
 */

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3);
}

/** Fraction of a reference's tokens that must appear in an identified
 * paragraph for it to count as "the same citation". Below 1 to tolerate a
 * stray token the model added. */
const CONTAINMENT_THRESHOLD = 0.8;
/** Below this many tokens a containment ratio is too noisy to trust. */
const MIN_TOKENS = 3;

export function dropAlreadyIdentified(
  references: readonly ParsedReference[],
  coveredTexts: readonly string[],
  identifierSpans: readonly string[],
): ParsedReference[] {
  const spans = identifierSpans.map((span) => span.toLowerCase());
  const coveredTokenSets = coveredTexts.map((text) => new Set(tokenize(text)));

  return references.filter((reference) => {
    const lower = reference.raw_text.toLowerCase();
    if (spans.some((span) => span.length > 0 && lower.includes(span))) {
      return false; // the reference text carries the identifier itself
    }
    const tokens = tokenize(reference.raw_text);
    if (tokens.length < MIN_TOKENS) {
      return true; // too little to judge — keep it
    }
    const reReport = coveredTokenSets.some((covered) => {
      const present = tokens.filter((token) => covered.has(token)).length;
      return present / tokens.length >= CONTAINMENT_THRESHOLD;
    });
    return !reReport;
  });
}
