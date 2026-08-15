/**
 * `HttpFetcher` backed by the recorded corpus.
 *
 * The contract that matters is what happens on a MISS: this fetcher throws,
 * naming the URL and the command that would record it. It never falls
 * through to the network (that would make the suite non-deterministic and
 * silently dependent on someone's connectivity) and it never falls back to a
 * generic 404 (that would let a spec "pass" while exercising the
 * service-unavailable path instead of the one it claims to test) — the
 * existing `fakeFetcher` 404s unknown URLs on purpose, and conflating the
 * two behaviours is exactly the mistake this class of test exists to avoid.
 *
 * A cassette that models a genuine 404 is a recorded 404, written down as
 * such.
 */
import type {
  FetchedResource,
  FetchOptions,
  HttpFetcher,
} from "../../lib/pipeline/sources/fetch-port";
import type { CorpusDocument, HttpCassette } from "./cassette";
import { httpCassetteKey, redactUrl } from "./cassette";
import {
  loadDocumentManifest,
  loadHttpCassettes,
  readDocument,
} from "./corpus-store";

export class CassetteMissError extends Error {
  constructor(
    readonly url: string,
    readonly accept: string | undefined,
    readonly key: string,
  ) {
    super(
      `No HTTP cassette for ${redactUrl(url)}` +
        (accept ? ` (accept: ${accept})` : "") +
        `\n  expected key: ${key}` +
        `\n  record it with: npm run corpus:record -- --http` +
        `\n  (the corpus never falls through to the live network)`,
    );
    this.name = "CassetteMissError";
  }
}

export class DocumentMissingError extends Error {
  constructor(name: string) {
    super(
      `Corpus document "${name}" is not present on disk.` +
        `\n  fetch it with: npm run corpus:fetch` +
        `\n  (large binaries are hash-pinned in documents.json, not committed)`,
    );
    this.name = "DocumentMissingError";
  }
}

export interface CassetteFetcher extends HttpFetcher {
  /** Every request served, in call order — the same affordance `fakeFetcher`
   * offers, so specs can assert on call sequences. */
  readonly calls: ReadonlyArray<{ url: string; options?: FetchOptions }>;
  /** Keys of cassettes this fetcher never served. A spec that thinks it
   * drove the Unpaywall path can prove it did. */
  unusedKeys(): string[];
  /**
   * Requests that had no cassette, redacted.
   *
   * Throwing on a miss is necessary but not sufficient, because several
   * callers deliberately swallow fetch errors to stay fail-open — Crossref's
   * `tryFetch` and Unpaywall's whole contract, for instance, treat any
   * throw as "the service had nothing to say". A missing recording would
   * therefore be absorbed and silently reinterpreted as a service outage,
   * and a spec asserting "no document url was derived" would pass for
   * entirely the wrong reason. Specs assert this list is empty.
   */
  misses(): string[];
}

export interface CassetteFetcherOptions {
  /** Restrict to a subset — used by specs that must prove a code path never
   * reaches a service (e.g. Unpaywall stays unconfigured). */
  readonly only?: readonly string[];
  /** Serve these responses ahead of the corpus, keyed by exact URL. For the
   * cases a recording cannot capture because no real server behaves that
   * way on demand — a host that mislabels HTML as `application/pdf`, a
   * connection that dies mid-body. Adversarial by construction, and marked
   * as such at the call site. */
  readonly adversarial?: Readonly<Record<string, Partial<FetchedResource>>>;
}

/**
 * Serves recorded responses through the same port the production fetcher
 * implements. Note what is deliberately NOT emulated: redirect following,
 * the SSRF guard and the 64 MiB cap live in `nodeHttpFetcher` and are tested
 * against a real loopback server there. Replaying them here would test the
 * replayer.
 */
export function cassetteFetcher(
  options: CassetteFetcherOptions = {},
): CassetteFetcher {
  const byKey = new Map<string, HttpCassette>();
  for (const cassette of loadHttpCassettes()) {
    if (options.only && !options.only.includes(cassette.key)) {
      continue;
    }
    byKey.set(cassette.key, cassette);
  }
  const documents = new Map<string, CorpusDocument>(
    loadDocumentManifest().documents.map((document) => [
      document.name,
      document,
    ]),
  );
  const calls: { url: string; options?: FetchOptions }[] = [];
  const used = new Set<string>();
  const missed: string[] = [];

  return {
    calls,
    unusedKeys: () => [...byKey.keys()].filter((key) => !used.has(key)).sort(),
    misses: () => [...missed],
    async fetch(url, fetchOptions) {
      calls.push(fetchOptions ? { url, options: fetchOptions } : { url });

      const adversarial = options.adversarial?.[url];
      if (adversarial) {
        return {
          status: adversarial.status ?? 200,
          contentType: adversarial.contentType ?? null,
          body: adversarial.body ?? Buffer.alloc(0),
          ...(adversarial.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: adversarial.retryAfterMs }),
        };
      }

      const key = httpCassetteKey(url, fetchOptions?.accept);
      const cassette = byKey.get(key);
      if (!cassette) {
        missed.push(redactUrl(url));
        throw new CassetteMissError(url, fetchOptions?.accept, key);
      }
      used.add(key);

      let body: Buffer;
      if (cassette.bodyDocument !== undefined) {
        const document = documents.get(cassette.bodyDocument);
        if (!document) {
          throw new DocumentMissingError(cassette.bodyDocument);
        }
        const bytes = readDocument(document);
        if (!bytes) {
          throw new DocumentMissingError(cassette.bodyDocument);
        }
        body = bytes;
      } else {
        body = Buffer.from(cassette.bodyText ?? "", "utf8");
      }

      return {
        status: cassette.status,
        contentType: cassette.contentType,
        body,
        ...(cassette.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: cassette.retryAfterMs }),
      };
    },
  };
}
