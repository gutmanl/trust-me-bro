import type { CrossrefWork } from "./crossref";

/**
 * Pure Crossref match scorer of the reference scan (reference auto-import):
 * scores how well one candidate Crossref work matches an LLM-parsed
 * citation, so run-reference-scan.ts can pick the best of up to
 * `RESULT_ROWS` search results (or none) without any network dependency
 * here.
 */

/** A match at or above this score is pre-selected by default in the review
 * (review.ts) — confident enough to trust without a second look. */
export const CONFIDENT_THRESHOLD = 0.72;

/** A match below this score is not attached at all: the candidate becomes
 * `unresolved` rather than carrying a barely-plausible guess. */
export const MATCH_FLOOR = 0.35;

function normalizeForBigrams(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(text: string): string[] {
  const normalized = normalizeForBigrams(text);
  if (normalized.length < 2) {
    return [];
  }
  const grams: string[] = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.push(normalized.slice(index, index + 2));
  }
  return grams;
}

/** Sørensen–Dice coefficient over character bigrams, 0..1 — robust to word
 * order and minor spelling differences between two title strings. */
export function titleSimilarity(a: string, b: string): number {
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  if (bigramsA.length === 0 || bigramsB.length === 0) {
    return 0;
  }
  const remaining = new Map<string, number>();
  for (const gram of bigramsA) {
    remaining.set(gram, (remaining.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (const gram of bigramsB) {
    const count = remaining.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      remaining.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (bigramsA.length + bigramsB.length);
}

export interface MatchableReference {
  title: string;
  year?: number;
  /** Author names as parsed (full names); only the first author's family
   * name is compared. */
  authors: readonly string[];
}

function familyNameOf(fullName: string): string {
  const words = fullName.trim().split(/\s+/);
  return words[words.length - 1] ?? "";
}

/**
 * Weighted match score of a parsed citation against one Crossref work:
 * 0.6 × title similarity (bigram Dice) + 0.25 × year match (exact = full
 * credit, ±1 = half credit, further apart or either year unknown = none) +
 * 0.15 × first-author family name match (case-insensitive equality).
 */
export function scoreMatch(
  parsed: MatchableReference,
  work: CrossrefWork,
): number {
  const titleScore = titleSimilarity(parsed.title, work.title ?? "");

  let yearScore = 0;
  if (parsed.year !== undefined && work.year !== undefined) {
    const diff = Math.abs(parsed.year - work.year);
    yearScore = diff === 0 ? 1 : diff === 1 ? 0.5 : 0;
  }

  const parsedFamily = parsed.authors[0]
    ? familyNameOf(parsed.authors[0]).toLowerCase()
    : "";
  const workFamily = work.authors[0]?.toLowerCase() ?? "";
  const authorScore =
    parsedFamily.length > 0 && parsedFamily === workFamily ? 1 : 0;

  return 0.6 * titleScore + 0.25 * yearScore + 0.15 * authorScore;
}
