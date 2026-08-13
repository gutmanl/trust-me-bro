import { normalizeForSearch } from "./normalize";

/**
 * Fuzzy quote-to-paragraph matching (anchor auto-repair): the exact
 * containment check of normalize.ts is the first line; this module is the
 * bounded second line for quotes the briefing no longer contains verbatim
 * (light rewording, punctuation drift after a revision). Pure, no Node
 * APIs — same discipline as normalize.ts.
 */

/** Minimum containment score for an automatic re-anchor. Deliberately
 * strict: a wrong anchor is worse than an unanchored claim, so the sweep
 * only acts on near-verbatim matches and leaves everything else to the
 * human repair flow. */
export const FUZZY_REANCHOR_THRESHOLD = 0.82;

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) {
    grams.add(text.slice(i, i + 2));
  }
  return grams;
}

/**
 * Recall of the quote's character bigrams within the paragraph, on the
 * shared normal form. Deliberately ASYMMETRIC — not Dice similarity: a
 * short quote matched against a long paragraph must not be penalized for
 * the paragraph's unrelated bulk. An exact substring scores 1.0; unrelated
 * text scores near 0.
 */
export function quoteContainmentScore(
  quote: string,
  paragraph: string,
): number {
  const normalizedQuote = normalizeForSearch(quote);
  const normalizedParagraph = normalizeForSearch(paragraph);
  if (normalizedQuote.length < 2 || normalizedParagraph.length < 2) {
    return 0;
  }
  if (normalizedParagraph.includes(normalizedQuote)) {
    return 1;
  }
  const quoteGrams = bigrams(normalizedQuote);
  const paragraphGrams = bigrams(normalizedParagraph);
  let found = 0;
  for (const gram of quoteGrams) {
    if (paragraphGrams.has(gram)) {
      found += 1;
    }
  }
  return found / quoteGrams.size;
}

/**
 * Best-scoring paragraph for the quote, or null when nothing clears the
 * threshold. Ties resolve to the earliest paragraph, mirroring the exact
 * resolver's first-match-wins rule. Returns the ZERO-BASED index.
 */
export function findFuzzyParagraph(
  quote: string,
  paragraphs: readonly string[],
  threshold: number = FUZZY_REANCHOR_THRESHOLD,
): number | null {
  let bestIndex: number | null = null;
  let bestScore = 0;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const score = quoteContainmentScore(quote, paragraphs[index]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestScore >= threshold ? bestIndex : null;
}
