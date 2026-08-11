/**
 * Normal form for verbatim-quote search (TMB-24, groundwork for stage 1):
 * the deterministic Wortlaut-Verifikation and the UI's advisory excerpt
 * check must share one notion of "the quote occurs in the frozen text" —
 * this module is that single notion. Pure, no Node APIs.
 */

/**
 * Canonicalizes text for containment checks: Unicode NFKC, lowercase,
 * typographic quotes/dashes folded to ASCII, line-break hyphenation
 * removed ("Review-\nzeit" → "reviewzeit"), whitespace collapsed.
 */
export function normalizeForSearch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[„“”«»‟]/g, '"')
      .replace(/[‚‘’‹›‛]/g, "'")
      .replace(/[–—‒−]/g, "-")
      // De-hyphenation must precede whitespace collapsing.
      .replace(/-[ \t]*\r?\n\s*/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
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
