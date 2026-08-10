import type { FetchedResource, FetchOptions, HttpFetcher } from "./fetch-port";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The single production HttpFetcher and the pipeline's only network call
 * site (architecture-guarded). Follows redirects (doi.org resolution is
 * redirect-based) and enforces a timeout so a hanging host cannot stall an
 * import step indefinitely.
 */
export const nodeHttpFetcher: HttpFetcher = {
  async fetch(
    url: string,
    options: FetchOptions = {},
  ): Promise<FetchedResource> {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        "user-agent": "trustmebro/0.1 (research prototype)",
        ...(options.accept ? { accept: options.accept } : {}),
      },
    });
    const contentTypeHeader = response.headers.get("content-type");
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    return {
      status: response.status,
      contentType: contentTypeHeader
        ? contentTypeHeader.split(";")[0].trim().toLowerCase()
        : null,
      body: Buffer.from(await response.arrayBuffer()),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  },
};

/** Parses a `Retry-After` header in either of its two RFC-legal forms: a
 * plain integer number of seconds, or an HTTP-date to wait until. Returns
 * undefined for a missing or unparseable header rather than guessing. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}
