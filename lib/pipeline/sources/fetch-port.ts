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
}

export interface FetchOptions {
  /** Accept header, e.g. CSL-JSON content negotiation against doi.org. */
  accept?: string;
  timeoutMs?: number;
}

export interface HttpFetcher {
  fetch(url: string, options?: FetchOptions): Promise<FetchedResource>;
}
