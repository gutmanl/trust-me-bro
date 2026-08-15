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
 *   4. Last resort → a Crossref `link[]` entry whose content-type is
 *      "unspecified" but whose URL is shaped like a PDF. Crossref metadata
 *      is often sloppy about content-type for works that ARE openly
 *      available, and this recovers them; it ranks below Unpaywall because
 *      Unpaywall actually KNOWS whether a work is open access, while this
 *      step is only guessing from a URL. For a closed work the same shape
 *      is usually a publisher paywall page, which is exactly what the
 *      `expectedExt` guard below is there to reject.
 *
 * Deliberately NEVER falls back to a landing page, `resource.primary.URL`,
 * or a link that is not at least PDF-SHAPED — those are usually paywalls or
 * abstracts and would poison the frozen corpus if captured as if they were
 * the paper (the second half of this defense is document.ts's `expectedExt`
 * guard, which fails the capture visibly if a derived URL turns out not to
 * serve a PDF after all — the ONLY thing standing behind step 4).
 *
 * Every step is non-fatal: a failure anywhere in the chain (network error,
 * non-200, no OA location, no e-mail configured, …) simply means no
 * document_url — never a thrown error, so a scan always completes.
 */
export interface DerivedDocumentUrl {
  documentUrl?: string;
  source?: DocumentUrlSource;
  /**
   * True when the URL is only INFERRED from a PDF-shaped link whose
   * content-type Crossref left unspecified (step 4) — nothing has asserted
   * it is a PDF, let alone a free one.
   *
   * Callers that hold another candidate document (a URL a human supplied,
   * or one a previous attempt already carried) must prefer THAT over a
   * guess: for a closed-access work the guess is typically the publisher's
   * paywall, which fails the capture with a 403 and would otherwise mask a
   * perfectly good author copy. In-memory only; the persisted
   * `document_url_source` still records plain "crossref_pdf".
   */
  guessed?: boolean;
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

  if (work?.probablePdfUrl) {
    // Still "crossref_pdf" as the recorded source: it IS a Crossref link[]
    // entry, and the distinction between an exact and a guessed
    // content-type is not worth a persisted enum value in the scan result.
    // `guessed` carries that distinction in memory, for callers that have a
    // better document on hand.
    return {
      documentUrl: work.probablePdfUrl,
      source: "crossref_pdf",
      guessed: true,
    };
  }

  return {};
}
