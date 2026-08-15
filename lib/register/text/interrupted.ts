import { normalizeForSearch } from "./normalize";

/**
 * Containment across an INTERRUPTION (stage 1's second line): the frozen
 * full text of a PDF is not always in reading order. A two-column paper
 * routinely has a copyright block, a figure caption, a running head or a
 * footnote emitted in the middle of a running sentence, so a quotation that
 * is verbatim present in the paper occurs in the extracted text as two
 * contiguous fragments with unrelated material between them.
 *
 * The exact containment of normalize.ts stays the first and preferred test.
 * This module answers the narrower question "are all of the quote's parts
 * present, in order, separated only by bounded interruptions" — and says so
 * explicitly in the result, so a pass obtained this way is never silently
 * indistinguishable from an exact one.
 *
 * Deliberately NOT fuzzy: every character of the quote must still be found
 * verbatim (under the shared normal form). Only contiguity is relaxed, and
 * only by a bounded amount. Nothing here can make a reworded or invented
 * quotation pass. Pure, no Node APIs — same discipline as its siblings.
 */

/** Longest run of interrupting text tolerated between two fragments. Sized
 * for the offenders actually observed — an ACM copyright block runs to
 * roughly 700 characters — with headroom, and far below the distance at
 * which two unrelated passages could plausibly be stitched together. */
export const MAX_INTERRUPTION_CHARS = 2000;

/** Fewest characters a fragment must contribute. A quote matched from many
 * tiny pieces would be assembled, not found; this is what keeps the check a
 * verbatim proof rather than a word search. */
export const MIN_FRAGMENT_CHARS = 25;

/** Most interruptions tolerated across one quote. A sentence may cross one
 * floating block; crossing several means the extraction is too disordered
 * to prove anything from. */
export const MAX_INTERRUPTIONS = 2;

export interface InterruptedMatch {
  /** Number of interruptions crossed; 0 means plain contiguous containment. */
  interruptions: number;
  /** Total characters of interrupting text skipped. */
  skipped: number;
}

/** Binary search for the longest prefix of `needle` satisfying `present`,
 * which must be monotone: if a prefix is absent, every longer one is too. */
function longestPrefix(
  needle: string,
  present: (prefix: string) => boolean,
): number {
  let low = 0;
  let high = needle.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (middle > 0 && present(needle.slice(0, middle))) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/** Fewest characters this fragment must contribute: a full fragment, or the
 * whole remainder when the quote ends in less than that. Without the second
 * case a short tail ("… idioms.") could never complete a match. */
function required(rest: string): number {
  return Math.min(MIN_FRAGMENT_CHARS, rest.length);
}

/**
 * Whether the needle occurs in the haystack contiguously, or as fragments
 * separated by at most `MAX_INTERRUPTIONS` interruptions of at most
 * `MAX_INTERRUPTION_CHARS` each. Null when it does not.
 *
 * Greedy anchor-and-extend: take the longest prefix still present, continue
 * from where it ended, and require the next fragment to resume within the
 * interruption budget. Greedy is sound here because each step consumes the
 * longest verbatim run available, and a shorter run could only place the
 * remainder further away, never closer.
 */
export function findInterrupted(
  haystack: string,
  needle: string,
): InterruptedMatch | null {
  const text = normalizeForSearch(haystack);
  const quote = normalizeForSearch(needle);
  if (quote.length === 0) {
    return null;
  }
  if (text.includes(quote)) {
    return { interruptions: 0, skipped: 0 };
  }

  // The opening fragment may begin anywhere; every later one must begin
  // exactly where the interruption budget said it would resume, so that no
  // distance goes uncounted.
  const opening = longestPrefix(quote, (prefix) => text.includes(prefix));
  if (opening < required(quote)) {
    return null;
  }
  let cursor = text.indexOf(quote.slice(0, opening)) + opening;
  let rest = quote.slice(opening);
  let interruptions = 0;
  let skipped = 0;

  while (rest.length > 0) {
    if (interruptions === MAX_INTERRUPTIONS) {
      return null;
    }
    const probe = rest.slice(0, required(rest));
    const resumes = text.indexOf(probe, cursor);
    if (resumes === -1 || resumes - cursor > MAX_INTERRUPTION_CHARS) {
      return null;
    }
    skipped += resumes - cursor;
    interruptions += 1;
    const length = longestPrefix(rest, (prefix) =>
      text.startsWith(prefix, resumes),
    );
    if (length < required(rest)) {
      return null;
    }
    cursor = resumes + length;
    rest = rest.slice(length);
  }
  return { interruptions, skipped };
}
