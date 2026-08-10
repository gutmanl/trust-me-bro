/**
 * Network port of the pipeline layer, mirroring the adapter layer's
 * ProcessRunner discipline: exactly one production implementation
 * (node-http-fetcher.ts), injectable fakes everywhere in tests, no other
 * module talks to the network directly.
 */

export interface FetchedResource {
  status: number;
  /** Lowercased Content-Type header without parameters, or null. */
  contentType: string | null;
  body: Buffer;
  /** Milliseconds to wait before retrying, parsed from a `Retry-After`
   * response header (seconds or HTTP-date form); absent when the header is
   * missing or unparseable. Additive (reference auto-import's Crossref
   * 429 handling); every other caller ignores it. */
  retryAfterMs?: number;
}

export interface FetchOptions {
  /** Accept header, e.g. CSL-JSON content negotiation against doi.org. */
  accept?: string;
  timeoutMs?: number;
}

export interface HttpFetcher {
  fetch(url: string, options?: FetchOptions): Promise<FetchedResource>;
}
