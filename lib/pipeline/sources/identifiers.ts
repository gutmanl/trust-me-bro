/**
 * Pure identifier handling for source capture: recognizes and canonicalizes
 * DOIs and arXiv ids from the forms users actually paste (bare id, prefixed
 * id, resolver URL).
 */

const DOI_PATTERN = /\b(10\.\d{4,9}\/\S+)/i;
const ARXIV_ID_PATTERN = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;

/** Canonical DOI ("10.xxxx/…") from bare, "doi:" or doi.org forms. */
export function normalizeDoi(raw: string): string | null {
  const match = DOI_PATTERN.exec(raw.trim());
  if (!match) {
    return null;
  }
  return match[1].replace(/[.,;)\]]+$/, "");
}

/** Canonical arXiv id ("2401.12345", version dropped) from bare, "arXiv:"
 * or arxiv.org URL forms. Old-style ids (math/0211159) are not supported. */
export function normalizeArxivId(raw: string): string | null {
  const match = ARXIV_ID_PATTERN.exec(raw.trim());
  return match ? match[1] : null;
}

/** True for http(s) URLs — the only ones the fetcher will touch. */
export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
