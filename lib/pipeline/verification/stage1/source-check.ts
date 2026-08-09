import { createHash } from "node:crypto";

import type { Source } from "../../../register";
import { IdentifierResolutionError } from "../../errors";
import type { HttpFetcher } from "../../sources/fetch-port";
import { isHttpUrl, normalizeArxivId } from "../../sources/identifiers";
import { resolveArxiv, resolveDoi } from "../../sources/resolve";

/**
 * Live half of stage 1 (TMB-27): identifier re-resolution against the
 * bibliographic services and URL re-fetch compared against the frozen
 * snapshot hash. Definitive negative answers (identifier does not resolve,
 * URL unreachable, document content changed) are `failed`; network
 * failures on OUR side throw and become run errors — the claim stays
 * unchanged, never wrongly failed (ratified decision on stage-1 semantics).
 *
 * The resolvers encode the distinction in their error `cause`: an
 * IdentifierResolutionError WITHOUT a cause is the service's own definitive
 * answer (HTTP status), one WITH a cause wraps a transport failure.
 */

export interface SourceCheckResult {
  ok: boolean;
  detail: string;
}

/** One result per source and run: sources back many claims, the live check
 * runs once. Keyed by source id; the promise dedupes concurrent checks. */
export type SourceCheckCache = Map<string, Promise<SourceCheckResult>>;

export function checkSourceCached(
  source: Source,
  fetcher: HttpFetcher,
  cache: SourceCheckCache,
): Promise<SourceCheckResult> {
  const cached = cache.get(source.id);
  if (cached) {
    return cached;
  }
  const pending = checkSourceLive(source, fetcher);
  cache.set(source.id, pending);
  return pending;
}

async function sha256OfUrl(
  url: string,
  fetcher: HttpFetcher,
): Promise<{ status: number; sha256?: string }> {
  const resource = await fetcher.fetch(url);
  if (resource.status !== 200) {
    return { status: resource.status };
  }
  return {
    status: resource.status,
    sha256: createHash("sha256").update(resource.body).digest("hex"),
  };
}

async function recheckUrlAgainstSnapshot(
  source: Source,
  url: string,
  fetcher: HttpFetcher,
): Promise<SourceCheckResult> {
  const { status, sha256 } = await sha256OfUrl(url, fetcher);
  if (status !== 200) {
    return {
      ok: false,
      detail: `URL nicht erreichbar (HTTP ${status}): ${url}`,
    };
  }
  const snapshotSha = source.custom.snapshot?.sha256;
  if (sha256 !== snapshotSha) {
    return {
      ok: false,
      detail: `Dokument weicht vom eingefrorenen Schnappschuss ab: ${url}`,
    };
  }
  return { ok: true, detail: `Snapshot bestätigt: ${url}` };
}

/**
 * The live check of one source, dispatched on its persisted CSL fields:
 * DOI → re-resolution (no document re-fetch — DOI landing pages are
 * paywalled too often to guess a document URL); arXiv URL → re-resolution
 * plus PDF re-fetch with hash comparison; plain URL → re-fetch with hash
 * comparison; upload without URL → vacuously passed (nothing live to check).
 */
export async function checkSourceLive(
  source: Source,
  fetcher: HttpFetcher,
): Promise<SourceCheckResult> {
  const url = typeof source.URL === "string" ? source.URL : undefined;
  const arxivId = url?.includes("arxiv.org") ? normalizeArxivId(url) : null;

  if (typeof source.DOI === "string" && source.DOI.length > 0) {
    return recheckResolution(() => resolveDoi(String(source.DOI), fetcher), {
      okDetail: `DOI aufgelöst: ${source.DOI}`,
    });
  }
  if (arxivId) {
    const resolution = await recheckResolution(
      () => resolveArxiv(arxivId, fetcher),
      { okDetail: `arXiv-Id aufgelöst: ${arxivId}` },
    );
    if (!resolution.ok) {
      return resolution;
    }
    return recheckUrlAgainstSnapshot(
      source,
      `https://arxiv.org/pdf/${arxivId}`,
      fetcher,
    );
  }
  if (url && isHttpUrl(url)) {
    return recheckUrlAgainstSnapshot(source, url, fetcher);
  }
  return {
    ok: true,
    detail: "Hochgeladene Quelle ohne Identifier/URL – keine Live-Prüfung.",
  };
}

async function recheckResolution(
  resolve: () => Promise<unknown>,
  { okDetail }: { okDetail: string },
): Promise<SourceCheckResult> {
  try {
    await resolve();
    return { ok: true, detail: okDetail };
  } catch (error) {
    if (error instanceof IdentifierResolutionError && !error.cause) {
      // The service's definitive answer (HTTP status ≠ 200).
      return { ok: false, detail: error.message };
    }
    throw error;
  }
}
