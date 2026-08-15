/**
 * Pure identifier handling for source capture: recognizes and canonicalizes
 * DOIs and arXiv ids from the forms users actually paste (bare id, prefixed
 * id, resolver URL).
 */

const DOI_PATTERN = /\b(10\.\d{4,9}\/\S+)/i;

/**
 * ANCHORED on purpose. Searching for this shape anywhere in the input is
 * what made `10.1109/eScience65000.2025.00093` read as the arXiv id
 * "2025.00093": a DOI suffix embedding a year-like number satisfies
 * `\d{4}\.\d{4,5}` as readily as a real id does, and two of the 83 DOIs in
 * the thesis's own research corpus do exactly that. The same shape of defect
 * filled the thesis's exclusion log with identifiers that were never
 * fabricated. Nothing is scanned now: each accepted form is recognized
 * structurally and the id must be the WHOLE of what is left.
 */
const ARXIV_ID_PATTERN = /^(\d{4}\.\d{4,5})(v\d+)?$/;

/** arxiv.org and its subdomains (export.arxiv.org), and nothing else. */
const ARXIV_HOST_PATTERN = /(^|\.)arxiv\.org$/i;

/** Canonical DOI ("10.xxxx/…") from bare, "doi:" or doi.org forms. */
export function normalizeDoi(raw: string): string | null {
  const match = DOI_PATTERN.exec(raw.trim());
  if (!match) {
    return null;
  }
  return match[1].replace(/[.,;)\]]+$/, "");
}

/** Canonical arXiv id ("2401.12345", version dropped) from bare, "arXiv:"
 * or arxiv.org URL forms — those three and nothing else, which is what keeps
 * a DOI from being read as an id (see ARXIV_ID_PATTERN). Old-style ids
 * (math/0211159) are not supported. */
export function normalizeArxivId(raw: string): string | null {
  const trimmed = raw.trim();
  // Resolver URL: the id is the last path segment (/abs/2401.12345,
  // /pdf/2401.12345v1.pdf). Callers hand whole URLs in — stage 1's live
  // source check passes a source's stored URL straight through — so this
  // form has to be read, not merely tolerated.
  if (isHttpUrl(trimmed)) {
    const url = new URL(trimmed);
    if (!ARXIV_HOST_PATTERN.test(url.hostname)) {
      return null;
    }
    const segment = url.pathname.split("/").filter(Boolean).pop() ?? "";
    return matchArxivId(segment.replace(/\.pdf$/i, ""));
  }
  return matchArxivId(trimmed.replace(/^arxiv:\s*/i, ""));
}

function matchArxivId(candidate: string): string | null {
  const match = ARXIV_ID_PATTERN.exec(candidate);
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
