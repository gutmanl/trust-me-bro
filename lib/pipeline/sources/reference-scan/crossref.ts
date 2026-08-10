import type { FetchedResource, HttpFetcher } from "../fetch-port";

/**
 * Crossref search of the reference scan (reference auto-import): resolves an
 * LLM-parsed citation that carries no identifier of its own (no DOI/arXiv-id
 * /URL) against the Crossref `/works` bibliographic search. Defensive manual
 * field extraction mirrors resolve.ts — Crossref's JSON is read field by
 * field, tolerant of a shifting external schema, never trusted blindly.
 *
 * Never throws: a network error or non-200 answers with an empty array, same
 * as "genuinely no results" — the caller (run-reference-scan.ts) treats an
 * empty array as "Crossref had nothing usable" and marks the candidate
 * `crossref_unavailable`. A 429 with a `Retry-After` of at most 10 seconds
 * is waited out ONCE and the request retried ONCE; any other outcome (no/too
 * long Retry-After, a second 429, a network error on retry) gives up and
 * also answers `[]` — Crossref's rate limit never blocks or fails the scan.
 */

export interface CrossrefWork {
  doi?: string;
  title?: string;
  /** Author family names, in the work's author order. */
  authors: string[];
  year?: number;
  venue?: string;
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
  if (!doi && !title) {
    return null;
  }
  return {
    ...(doi ? { doi } : {}),
    ...(title ? { title } : {}),
    authors,
    ...(year !== undefined ? { year } : {}),
    ...(venue ? { venue } : {}),
  };
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

export async function searchCrossref(
  query: string,
  fetcher: HttpFetcher,
  deps: CrossrefDependencies = {},
): Promise<CrossrefWork[]> {
  const sleep = deps.sleep ?? defaultSleep;
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${RESULT_ROWS}`;

  let resource = await tryFetch(url, fetcher);
  if (resource === null) {
    return [];
  }
  if (resource.status === 429) {
    const retryAfterMs = resource.retryAfterMs;
    if (retryAfterMs !== undefined && retryAfterMs <= MAX_RETRY_AFTER_MS) {
      await sleep(retryAfterMs);
      resource = await tryFetch(url, fetcher);
      if (resource === null) {
        return [];
      }
    }
  }
  if (resource.status !== 200) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(resource.body.toString("utf8"));
  } catch {
    return [];
  }
  const message = (parsed as Record<string, unknown> | null)?.message as
    Record<string, unknown> | undefined;
  const items = message?.items;
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map(extractWork)
    .filter((work): work is CrossrefWork => work !== null);
}
