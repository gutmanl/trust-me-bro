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
 * Deterministic de-duplication: a parsed reference is dropped when it sits on
 * a briefing line that already produced an identifier hit. The match is by
 * WORD-TOKEN containment, not raw substring, because the model reformats the
 * citation it copies — typographic vs. straight quotes, em-dashes, dropped
 * parentheticals — so a strict substring check misses the very re-reports
 * this exists to remove. A reference is dropped when (almost) all of its
 * word tokens appear in one identifier line, or when it carries the
 * identifier span (URL/DOI/arXiv) itself. One citation per line is the norm
 * in a prose briefing, so this keeps the authoritative identifier candidate
 * and removes the re-report.
 */

export interface IdentifierSpan {
  /** The whole briefing line the identifier was found on. */
  raw_text: string;
  /** The exact identifier span (URL/DOI/arXiv) within that line. */
  matchedText: string;
}

/** Fraction of a reference's tokens that must appear in an identifier line
 * for it to count as "the same citation". Below 1 to tolerate a stray token
 * the model added; high enough that a genuinely different citation, which
 * shares only incidental words, stays. */
const CONTAINMENT_THRESHOLD = 0.8;
/** Below this many tokens a containment ratio is too noisy to trust (a short
 * fragment's words trivially appear in a long paragraph). */
const MIN_TOKENS = 3;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3);
}

export function dropAlreadyIdentified(
  references: readonly ParsedReference[],
  identifiers: readonly IdentifierSpan[],
): ParsedReference[] {
  const lineTokenSets = identifiers.map(
    (hit) => new Set(tokenize(hit.raw_text)),
  );
  const spans = identifiers.map((hit) => hit.matchedText.toLowerCase());
  return references.filter((reference) => {
    const lower = reference.raw_text.toLowerCase();
    if (spans.some((span) => span.length > 0 && lower.includes(span))) {
      return false; // the reference text carries the identifier itself
    }
    const tokens = tokenize(reference.raw_text);
    if (tokens.length < MIN_TOKENS) {
      return true; // too little to judge — keep it
    }
    const onIdentifiedLine = lineTokenSets.some((lineTokens) => {
      const present = tokens.filter((token) => lineTokens.has(token)).length;
      return present / tokens.length >= CONTAINMENT_THRESHOLD;
    });
    return !onIdentifiedLine;
  });
}
