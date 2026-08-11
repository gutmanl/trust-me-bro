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
 * Deterministic de-duplication: a parsed reference is dropped when its
 * `raw_text` shares a briefing line with an identifier hit — either the
 * reference text sits inside that line, the line sits inside the reference
 * text, or the reference text contains the identifier's matched span
 * (URL/DOI/arXiv). One citation per line is the norm in a prose briefing, so
 * this removes the re-report while keeping the authoritative identifier
 * candidate.
 */

export interface IdentifierSpan {
  /** The whole briefing line the identifier was found on. */
  raw_text: string;
  /** The exact identifier span (URL/DOI/arXiv) within that line. */
  matchedText: string;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function dropAlreadyIdentified(
  references: readonly ParsedReference[],
  identifiers: readonly IdentifierSpan[],
): ParsedReference[] {
  const lines = identifiers.map((hit) => normalize(hit.raw_text));
  const spans = identifiers.map((hit) => normalize(hit.matchedText));
  return references.filter((reference) => {
    const text = normalize(reference.raw_text);
    if (text.length === 0) {
      return true;
    }
    const onIdentifiedLine = lines.some(
      (line) => line.includes(text) || text.includes(line),
    );
    const carriesIdentifier = spans.some((span) => text.includes(span));
    return !onIdentifiedLine && !carriesIdentifier;
  });
}
