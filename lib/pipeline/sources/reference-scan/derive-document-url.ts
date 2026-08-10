import { getUnpaywallEmail } from "../../../identity";
import type { HttpFetcher } from "../fetch-port";
import { fetchCrossrefWorkByDoi } from "./crossref";
import type { DocumentUrlSource } from "./schema";
import { fetchUnpaywallPdfUrl } from "./unpaywall";

/**
 * Document-URL derivation of the reference scan (reference auto-import,
 * Task 3b) — the fix for `captureSource`'s doi/crossref_title candidates
 * otherwise having no document to acquire (resolveDoi deliberately derives
 * none; DOI landing pages are too often paywalled to guess a PDF link from
 * the DOI alone). Fixed, NEVER-reordered derivation chain, first hit wins:
 *
 *   1. arXiv id present → the arXiv PDF URL (no network call needed).
 *   2. Crossref work `link[]` entry with content-type EXACTLY
 *      "application/pdf" → its URL.
 *   3. DOI present and still nothing → Unpaywall's best open-access PDF.
 *
 * Deliberately NEVER falls back to a landing page, `resource.primary.URL`,
 * or a non-PDF link at any step — those are usually paywalls or abstracts
 * and would poison the frozen corpus if captured as if they were the paper
 * (the second half of this defense is document.ts's `expectedExt` guard,
 * which fails the capture visibly if a derived URL turns out not to serve a
 * PDF after all).
 *
 * Every step is non-fatal: a failure anywhere in the chain (network error,
 * non-200, no OA location, no e-mail configured, …) simply means no
 * document_url — never a thrown error, so a scan always completes.
 */
export interface DerivedDocumentUrl {
  documentUrl?: string;
  source?: DocumentUrlSource;
}

export interface DeriveDocumentUrlDeps {
  fetcher: HttpFetcher;
  /** Crossref Retry-After wait, injectable so tests never sleep for real. */
  sleep?: (ms: number) => Promise<void>;
}

export async function deriveDocumentUrl(
  identifiers: { doi?: string; arxivId?: string },
  deps: DeriveDocumentUrlDeps,
): Promise<DerivedDocumentUrl> {
  if (identifiers.arxivId) {
    return {
      documentUrl: `https://arxiv.org/pdf/${identifiers.arxivId}`,
      source: "arxiv",
    };
  }

  const doi = identifiers.doi;
  if (!doi) {
    return {};
  }

  const work = await fetchCrossrefWorkByDoi(doi, deps.fetcher, {
    sleep: deps.sleep,
  });
  if (work?.pdfUrl) {
    return { documentUrl: work.pdfUrl, source: "crossref_pdf" };
  }

  const email = getUnpaywallEmail();
  const unpaywallPdfUrl = await fetchUnpaywallPdfUrl(doi, email, deps.fetcher);
  if (unpaywallPdfUrl) {
    return { documentUrl: unpaywallPdfUrl, source: "unpaywall" };
  }

  return {};
}
