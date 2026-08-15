import type { FetchedResource, HttpFetcher } from "../fetch-port";

/**
 * Crossref search of the reference scan (reference auto-import): resolves an
 * LLM-parsed citation that carries no identifier of its own (no DOI/arXiv-id
 * /URL) against the Crossref `/works` bibliographic search. Defensive manual
 * field extraction mirrors resolve.ts — Crossref's JSON is read field by
 * field, tolerant of a shifting external schema, never trusted blindly.
 *
 * Never throws: a network error, non-200, exhausted 429 retry or malformed
 * JSON body sets `unavailable: true` with an empty `works` array — the
 * caller (run-reference-scan.ts) marks the candidate `crossref_unavailable`
 * ONLY in that case (I3 fix: this is truthfully "Crossref could not be
 * reached/answered at all", distinct from a normal 200 response that simply
 * carries zero or no matching items, which answers `unavailable: false` with
 * an empty `works` array — Crossref genuinely had nothing, a retry would not
 * help). A 429 with a `Retry-After` of at most 10 seconds is waited out ONCE
 * and the request retried ONCE; any other outcome (no/too long Retry-After,
 * a second 429, a network error on retry) gives up and also answers
 * `unavailable: true` — Crossref's rate limit never blocks or fails the scan.
 *
 * `fetchCrossrefWorkByDoi` (reference auto-import, Task 3b) is the second
 * entry point: a single-work lookup by DOI, used by derive-document-url.ts
 * to read a work's `link[]` PDF entry without a bibliographic search. Same
 * never-throws/429-retry-once discipline, sharing the fetch+retry mechanics
 * with `searchCrossref` via `fetchCrossrefJson`.
 */

export interface CrossrefWork {
  doi?: string;
  title?: string;
  /** Author family names, in the work's author order. */
  authors: string[];
  year?: number;
  venue?: string;
  /** URL of a Crossref-listed link entry with content-type EXACTLY
   * "application/pdf" (reference auto-import, Task 3b). Deliberately never
   * a landing page or `resource.primary.URL` — those are usually paywalls
   * or abstracts and would poison the frozen corpus if captured as if they
   * were the paper. Absent when no such link exists. */
  pdfUrl?: string;
  /**
   * URL of a link entry whose content-type Crossref left "unspecified" (or
   * omitted) but whose URL is shaped like a PDF. Weaker evidence than
   * `pdfUrl` on purpose: Crossref metadata is frequently sloppy about
   * content-type for works that ARE openly available, and this recovers
   * them — but for a closed work the same shape is usually a publisher
   * paywall page. Only ever used as the LAST resort in the derivation
   * chain, and only behind document.ts's `expectedExt` guard, which fails
   * the capture visibly when the response is not really a PDF.
   */
  probablePdfUrl?: string;
}

export interface CrossrefDependencies {
  /** Injectable wait for the Retry-After path; tests keep this instant
   * instead of actually sleeping. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRY_AFTER_MS = 10_000;
const RESULT_ROWS = 5;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function extractWork(raw: unknown): CrossrefWork | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const doi = typeof item.DOI === "string" ? item.DOI : undefined;
  const titleArray = item.title;
  const title =
    Array.isArray(titleArray) && typeof titleArray[0] === "string"
      ? titleArray[0]
      : undefined;
  const authorArray = Array.isArray(item.author) ? item.author : [];
  const authors = authorArray
    .map((author) => {
      const family = (author as Record<string, unknown> | null)?.family;
      return typeof family === "string" ? family : undefined;
    })
    .filter((family): family is string => family !== undefined);
  const issued = item.issued as Record<string, unknown> | undefined;
  const dateParts = issued?.["date-parts"];
  const year =
    Array.isArray(dateParts) &&
    Array.isArray(dateParts[0]) &&
    typeof dateParts[0][0] === "number"
      ? dateParts[0][0]
      : undefined;
  const containerArray = item["container-title"];
  const venue =
    Array.isArray(containerArray) && typeof containerArray[0] === "string"
      ? containerArray[0]
      : undefined;
  // Content-type must match EXACTLY — no landing pages, no
  // resource.primary.URL, no "similarity checking" or other non-PDF link
  // types (reference auto-import, Task 3b: corpus-integrity requirement).
  const linkArray = item.link;
  const pdfLink = Array.isArray(linkArray)
    ? linkArray.find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as Record<string, unknown>)["content-type"] ===
            "application/pdf",
      )
    : undefined;
  const pdfUrl = linkUrlOf(pdfLink);
  // Second tier: content-type says nothing, but the URL is shaped like a
  // PDF. See CrossrefWork.probablePdfUrl for why this is kept separate.
  const probableLink = Array.isArray(linkArray)
    ? linkArray.find((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return false;
        }
        const contentType = (entry as Record<string, unknown>)["content-type"];
        const unspecified =
          contentType === undefined ||
          contentType === null ||
          contentType === "unspecified";
        return unspecified && looksLikePdfUrl(linkUrlOf(entry));
      })
    : undefined;
  const probablePdfUrl = linkUrlOf(probableLink);
  if (!doi && !title) {
    return null;
  }
  return {
    ...(doi ? { doi } : {}),
    ...(title ? { title } : {}),
    authors,
    ...(year !== undefined ? { year } : {}),
    ...(venue ? { venue } : {}),
    ...(pdfUrl ? { pdfUrl } : {}),
    ...(probablePdfUrl ? { probablePdfUrl } : {}),
  };
}

/** The `URL` field of a Crossref `link[]` entry, when it is a string. */
function linkUrlOf(entry: unknown): string | undefined {
  const url = (entry as Record<string, unknown> | undefined)?.URL;
  return typeof url === "string" ? url : undefined;
}

/** Whether a URL is shaped like a direct PDF link (`….pdf` or `…/pdf/…`). */
function looksLikePdfUrl(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return pathname.endsWith(".pdf") || pathname.includes("/pdf/");
}

async function tryFetch(
  url: string,
  fetcher: HttpFetcher,
): Promise<FetchedResource | null> {
  try {
    return await fetcher.fetch(url, { accept: "application/json" });
  } catch {
    return null;
  }
}

/** Shared fetch/429-retry-once/JSON-parse mechanics of both Crossref entry
 * points below — the ONLY difference between a bibliographic search and a
 * single-work-by-DOI lookup is the URL and what shape `message` has, both
 * handled by the respective callers. Never throws: any failure at any step
 * answers `null`, exactly like "Crossref had nothing to say". */
async function fetchCrossrefJson(
  url: string,
  fetcher: HttpFetcher,
  deps: CrossrefDependencies,
): Promise<unknown | null> {
  const sleep = deps.sleep ?? defaultSleep;

  let resource = await tryFetch(url, fetcher);
  if (resource === null) {
    return null;
  }
  if (resource.status === 429) {
    const retryAfterMs = resource.retryAfterMs;
    if (retryAfterMs !== undefined && retryAfterMs <= MAX_RETRY_AFTER_MS) {
      await sleep(retryAfterMs);
      resource = await tryFetch(url, fetcher);
      if (resource === null) {
        return null;
      }
    }
  }
  if (resource.status !== 200) {
    return null;
  }

  try {
    return JSON.parse(resource.body.toString("utf8"));
  } catch {
    return null;
  }
}

export interface CrossrefSearchResult {
  works: CrossrefWork[];
  /** True ONLY when Crossref could not be reached/answered at all for this
   * query (network error, non-200, exhausted 429 retry, malformed JSON) —
   * see the module doc comment. False for a normal 200 response, even one
   * with zero matching items: Crossref answered, it just had nothing. */
  unavailable: boolean;
}

export async function searchCrossref(
  query: string,
  fetcher: HttpFetcher,
  deps: CrossrefDependencies = {},
): Promise<CrossrefSearchResult> {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${RESULT_ROWS}`;
  const parsed = await fetchCrossrefJson(url, fetcher, deps);
  if (parsed === null) {
    return { works: [], unavailable: true };
  }
  const message = (parsed as Record<string, unknown>).message as
    Record<string, unknown> | undefined;
  const items = message?.items;
  if (!Array.isArray(items)) {
    return { works: [], unavailable: false };
  }
  return {
    works: items
      .map(extractWork)
      .filter((work): work is CrossrefWork => work !== null),
    unavailable: false,
  };
}

/**
 * Single-work Crossref lookup by DOI (reference auto-import, Task 3b): used
 * by derive-document-url.ts to read a specific work's `link[]` PDF entry
 * without spending a bibliographic-search call. `null` on any failure
 * (network error, non-200, exhausted 429 retry, malformed JSON, or a
 * response with neither a DOI nor a title) — never throws.
 */
export async function fetchCrossrefWorkByDoi(
  doi: string,
  fetcher: HttpFetcher,
  deps: CrossrefDependencies = {},
): Promise<CrossrefWork | null> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const parsed = await fetchCrossrefJson(url, fetcher, deps);
  const message = (parsed as Record<string, unknown> | null)?.message;
  return extractWork(message);
}
