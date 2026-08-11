import { lookup } from "node:dns/promises";

import { ResourceLimitExceededError } from "../errors";
import type { FetchedResource, FetchOptions, HttpFetcher } from "./fetch-port";
import { assertAllowedUrl, type HostResolver } from "./private-address";

const DEFAULT_TIMEOUT_MS = 30_000;

/** The production host resolver: every address the OS resolver returns for a
 * name (so a name that resolves to even one non-public address is refused).
 * Kept here, in the sanctioned network module, rather than in the pure
 * address classifier. */
const nodeHostResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

/** Injectable seam: the SSRF address guard. The default enforces the real
 * policy; tests that fetch a loopback server inject a permissive check. */
export interface NodeHttpFetcherDeps {
  checkUrl?: (url: string) => Promise<void>;
}

/**
 * Resource limits (S-06). Sources are fetched from addresses that come out
 * of a briefing, i.e. from material of uncertain provenance — so the size
 * of what comes back cannot be left to the other end. Without these, a
 * single response could exhaust memory before anything looked at it.
 *
 * The size cap is generous on purpose: real scholarly PDFs with figures
 * routinely pass 20 MB, and refusing a legitimate source would be a worse
 * failure than the one being prevented.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const MAX_REDIRECTS = 10;

/**
 * Builds the production HttpFetcher — the pipeline's only network call site
 * (architecture-guarded). Redirects are followed manually rather than by
 * `redirect: "follow"`: the chain has to be counted to be bounded, counting
 * it here keeps the timeout covering the whole chain instead of restarting
 * per hop, and it is the point at which each hop's address is re-checked.
 *
 * A factory only so the SSRF address guard can be injected: the exported
 * nodeHttpFetcher enforces the real policy, while a test fetching a loopback
 * server passes a permissive checkUrl.
 */
export function createNodeHttpFetcher(
  deps: NodeHttpFetcherDeps = {},
): HttpFetcher {
  const checkUrl =
    deps.checkUrl ?? ((url) => assertAllowedUrl(url, nodeHostResolver));
  return {
    async fetch(
      url: string,
      options: FetchOptions = {},
    ): Promise<FetchedResource> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // One signal for the entire call, redirects included — a chain of slow
      // hops must not be able to outlast the budget by resetting it.
      const signal = AbortSignal.timeout(timeoutMs);

      let currentUrl = url;
      let response: Response;
      let redirects = 0;
      for (;;) {
        // SSRF guard, re-checked on every hop: a redirect can point at a
        // private address just as an initial URL can.
        await checkUrl(currentUrl);
        response = await fetch(currentUrl, {
          redirect: "manual",
          signal,
          headers: {
            "user-agent": "trustmebro/0.1",
            ...(options.accept ? { accept: options.accept } : {}),
          },
        });
        const location = response.headers.get("location");
        if (
          response.status < 300 ||
          response.status >= 400 ||
          location === null
        ) {
          break;
        }
        // Release the connection instead of leaving an unread body behind:
        // with redirect: "manual" the intermediate bodies are never
        // consumed, and cancelling them is what keeps a long chain from
        // pulling bytes that no size cap would ever see.
        await response.body?.cancel();
        redirects += 1;
        if (redirects > MAX_REDIRECTS) {
          throw new ResourceLimitExceededError(
            `Abruf abgebrochen: mehr als ${MAX_REDIRECTS} Weiterleitungen ab ${url}.`,
          );
        }
        // Relative Location headers are legal and common.
        currentUrl = new URL(location, currentUrl).toString();
      }

      const contentTypeHeader = response.headers.get("content-type");
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      return {
        status: response.status,
        contentType: contentTypeHeader
          ? contentTypeHeader.split(";")[0].trim().toLowerCase()
          : null,
        body: await readCappedBody(response, currentUrl),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    },
  };
}

/** The single production HttpFetcher, with the real SSRF address guard. */
export const nodeHttpFetcher: HttpFetcher = createNodeHttpFetcher();

/**
 * Reads the body while enforcing the size cap. A declared Content-Length
 * over the cap is refused before a single byte is read; beyond that the
 * stream is measured as it arrives, because Content-Length may be absent
 * (chunked) or simply untrue. Buffering the whole response first and
 * checking afterwards would be no protection at all.
 */
async function readCappedBody(
  response: Response,
  url: string,
): Promise<Buffer> {
  const tooLarge = (): never => {
    throw new ResourceLimitExceededError(
      `Abruf abgebrochen: ${url} überschreitet die Größengrenze von ` +
        `${Math.round(MAX_RESPONSE_BYTES / (1024 * 1024))} MB.`,
    );
  };

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    tooLarge();
  }

  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

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
