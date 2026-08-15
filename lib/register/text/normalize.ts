/**
 * Normal form for verbatim-quote search (TMB-24, groundwork for stage 1):
 * the deterministic Wortlaut-Verifikation and the UI's advisory excerpt
 * check must share one notion of "the quote occurs in the frozen text" —
 * this module is that single notion. Pure, no Node APIs.
 */

/**
 * Canonicalizes text for containment checks: Unicode NFKC, lowercase,
 * typographic quotes/dashes folded to ASCII, line-break hyphenation joined
 * ("Review-\nzeit" → "reviewzeit"), remaining hyphens dropped, whitespace
 * collapsed.
 *
 * Dropping the remaining hyphens is what makes the join above SAFE, and it
 * is not a relaxation but a correction. A typeset line may break at a
 * hyphen that genuinely belongs to the word ("high-\nperformance"), and the
 * join alone cannot tell that apart from a German compound split
 * ("Review-\nzeit"). Resolving both to the hyphen-free form makes the two
 * cases agree instead of guessing: the quote's "high-performance" and the
 * PDF's "high-\nperformance" both become "highperformance", while
 * "Reviewzeit" still finds "Review-\nzeit". Without it the join silently
 * manufactures tokens ("highperformance") that no faithful quote can ever
 * contain, and stage 1 rejects wording that is verifiably present.
 *
 * Order is load-bearing throughout: dashes fold before the join (so an en
 * dash ending a line is not mistaken for hyphenation), the join precedes
 * the hyphen drop (so it can still consume the line break and close the
 * word up), and whitespace collapses LAST (so a dropped hyphen between
 * spaces — "conditions – a task" — leaves one space, not two).
 */
export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[„“”«»‟]/g, '"')
    .replace(/[‚‘’‹›‛]/g, "'")
    .replace(/[–—‒−]/g, "-")
    .replace(/-[ \t]*\r?\n\s*/g, "")
    .replace(/-/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the normalized needle occurs in the normalized haystack. */
export function containsNormalized(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeForSearch(needle);
  if (normalizedNeedle.length === 0) {
    return false;
  }
  return normalizeForSearch(haystack).includes(normalizedNeedle);
}

/** Canonical paragraph split shared by projection, re-anchoring and the
 * extraction pipeline: CRLF→LF, trim, split on blank lines. */
export function splitBriefingParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized.length > 0 ? normalized.split(/\n{2,}/) : [];
}
