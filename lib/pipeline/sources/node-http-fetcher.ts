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
    return {
      status: response.status,
      contentType: contentTypeHeader
        ? contentTypeHeader.split(";")[0].trim().toLowerCase()
        : null,
      body: Buffer.from(await response.arrayBuffer()),
    };
  },
};
