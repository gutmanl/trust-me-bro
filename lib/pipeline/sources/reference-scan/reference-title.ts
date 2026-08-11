/**
 * Cleans a reference title before it is used to query and score Crossref
 * (reference auto-import). Real footnote and web-scraped references — the
 * kind Elicit and Perplexity emit — pollute the title in ways that wreck the
 * bigram similarity score against Crossref's clean title:
 *
 * - a trailing " | <Site/Venue>" suffix ("… Variants | OpenReview."),
 * - an ellipsis where the tool truncated a long title ("… Scenario-Based …"),
 * - surrounding quotes and trailing sentence punctuation.
 *
 * Stripping these is safe for matching: Crossref's bibliographic search is
 * fuzzy and handles a shortened title, and academic titles almost never
 * contain a " | " of their own. Pure and deterministic.
 */
export function cleanReferenceTitle(raw: string): string {
  let title = raw.trim();

  // Drop a trailing " | <site/venue>" segment (keep the title before it).
  const pipe = title.lastIndexOf(" | ");
  if (pipe > 0) {
    title = title.slice(0, pipe);
  }

  // Drop a trailing ellipsis (three dots or the … character) marking a
  // truncation, plus any trailing sentence punctuation.
  title = title.replace(/\s*(?:\.{3}|…)\s*$/u, "");
  title = title.replace(/[.,;:]+\s*$/u, "");

  // Drop surrounding straight or typographic quotes.
  title = title.replace(/^["'“”„]+|["'“”„]+$/gu, "");

  return title.trim();
}
