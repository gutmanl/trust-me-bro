import { normalizeArxivId, normalizeDoi } from "../identifiers";

/**
 * Regex channel of the reference scan (reference auto-import): a pure,
 * deterministic pass over the frozen briefing text that finds DOI, arXiv-id
 * and URL spans by pattern alone — the channel that NEVER depends on a
 * backend being usable (see run-reference-scan.ts's degradation doc
 * comment). Canonicalization is delegated to the existing capture-side
 * normalizers (identifiers.ts) so the same DOI/arXiv shape rules apply
 * whether a source was typed in by hand or found by the scan.
 *
 * False-positive discipline:
 * - arXiv ids are only recognized with an explicit "arXiv:" prefix or inside
 *   an arxiv.org URL — a bare "2401.12345"-shaped number in running prose is
 *   NOT enough (too easy to collide with e.g. a page range or a phone-style
 *   number).
 * - URLs on doi.org/arxiv.org hosts are excluded from the URL channel: they
 *   are already claimed by the DOI/arXiv channels (a doi.org link IS a DOI,
 *   just spelled as a URL), so counting them twice would double the
 *   candidate for the same work.
 * - Trailing sentence punctuation is trimmed off every matched span before
 *   normalization.
 */

export interface ReferenceRegexHit {
  method: "doi" | "arxiv" | "url";
  /** The line the span was found on — the candidate's `raw_text`. */
  raw_text: string;
  /** The exact matched (trimmed) span, used as the "already_detected" hint
   * for the LLM channel so it does not re-report the same citation. */
  matchedText: string;
  doi?: string;
  arxiv_id?: string;
  url?: string;
}

const DOI_SCAN_PATTERN = /10\.\d{4,9}\/[^\s,;)\]]+/g;
const ARXIV_PREFIXED_PATTERN = /\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const ARXIV_URL_PATTERN =
  /\barxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/gi;
const URL_SCAN_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

function trimTrailingPunctuation(text: string): string {
  return text.replace(/[.,;:)\]]+$/, "");
}

function isDoiOrArxivHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "doi.org" ||
    host.endsWith(".doi.org") ||
    host === "arxiv.org" ||
    host.endsWith(".arxiv.org")
  );
}

/** Scans the briefing text for regex-detectable citations, line by line. */
export function scanRegex(briefingText: string): ReferenceRegexHit[] {
  const hits: ReferenceRegexHit[] = [];

  for (const rawLine of briefingText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    for (const match of line.matchAll(DOI_SCAN_PATTERN)) {
      const span = trimTrailingPunctuation(match[0]);
      const doi = normalizeDoi(span);
      if (doi) {
        hits.push({ method: "doi", raw_text: line, matchedText: span, doi });
      }
    }

    for (const match of line.matchAll(ARXIV_PREFIXED_PATTERN)) {
      const arxivId = normalizeArxivId(match[1]);
      if (arxivId) {
        hits.push({
          method: "arxiv",
          raw_text: line,
          matchedText: match[0].trim(),
          arxiv_id: arxivId,
        });
      }
    }
    for (const match of line.matchAll(ARXIV_URL_PATTERN)) {
      const arxivId = normalizeArxivId(match[1]);
      if (arxivId) {
        hits.push({
          method: "arxiv",
          raw_text: line,
          matchedText: match[0].trim(),
          arxiv_id: arxivId,
        });
      }
    }

    for (const match of line.matchAll(URL_SCAN_PATTERN)) {
      const span = trimTrailingPunctuation(match[0]);
      let parsed: URL;
      try {
        parsed = new URL(span);
      } catch {
        continue;
      }
      if (isDoiOrArxivHost(parsed.hostname)) {
        continue;
      }
      hits.push({
        method: "url",
        raw_text: line,
        matchedText: span,
        url: span,
      });
    }
  }

  return hits;
}
