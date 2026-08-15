/**
 * Cassette format and key derivation for the real-world corpus.
 *
 * The corpus exists because every network- and LLM-facing test in this
 * repository used to run against fixtures the developers wrote by hand: the
 * Crossref/Unpaywall/arXiv response shapes, the LLM output shapes and the
 * similarity thresholds tuned against them were all self-referential. A
 * cassette is one recorded interaction with the outside world, captured by
 * `scripts/record-corpus.ts` against the REAL ports and replayed
 * deterministically here.
 *
 * Two provenance states, both first-class:
 *
 * - `synthetic` — authored in-repo, shaped after the response the code
 *   actually parses. Every cassette starts here so the suite is green and
 *   the failure paths are exercised before anyone has run the recorder.
 * - `recorded` — captured from the live service. `npm run corpus:record`
 *   overwrites a synthetic cassette in place and flips the provenance; the
 *   specs do not change.
 *
 * `tests/corpus/corpus-integrity.test.ts` reports the split, so "how much of
 * this is real?" is a question the suite answers rather than a comment
 * someone has to keep up to date.
 */
import { createHash } from "node:crypto";

import { canonicalize } from "../../lib/register/chain/canonical-json";

/** Where a cassette's content came from. Recorded cassettes carry enough to
 * re-run the capture and to date the observation. */
export type CassetteProvenance =
  | {
      readonly kind: "synthetic";
      /** Why this shape — normally the parser it has to satisfy. */
      readonly note: string;
    }
  | {
      readonly kind: "recorded";
      /** ISO-8601 instant the interaction was captured. */
      readonly recorded_at: string;
      /** Recorder version, so a format change is traceable. */
      readonly recorder: string;
    };

export interface HttpCassette {
  /** Canonical request key; equals the file's basename. */
  readonly key: string;
  /** Request URL as the code issues it, with volatile parameters redacted
   * (see `redactUrl`). */
  readonly url: string;
  /** Accept header the caller set, when it set one (DOI content
   * negotiation). */
  readonly accept?: string;
  readonly status: number;
  /** Lowercased Content-Type without parameters, mirroring FetchedResource. */
  readonly contentType: string | null;
  /** Text body, for the JSON/XML/HTML responses this system parses. Mutually
   * exclusive with `bodyDocument`. */
  readonly bodyText?: string;
  /** Name of an entry in `documents.json`, for binary bodies (PDFs) that are
   * too large to commit and are fetched by `npm run corpus:fetch` instead. */
  readonly bodyDocument?: string;
  /** Parsed Retry-After, for the Crossref 429 path. */
  readonly retryAfterMs?: number;
  readonly provenance: CassetteProvenance;
}

export interface LlmCassette {
  readonly key: string;
  /** Job kind — the trace envelope's `method`. */
  readonly method: string;
  /** The exact job input the orchestrator passed. */
  readonly params: unknown;
  /** The validated structured output the backend returned. */
  readonly result: unknown;
  /** Backend id and model, when recorded from a real run. */
  readonly backend?: string;
  readonly model?: string;
  /** Prompt version and hash the recording was made against — a prompt
   * change invalidates the recording, and this is what says so. */
  readonly prompt_version?: string;
  readonly prompt_sha256?: string;
  readonly provenance: CassetteProvenance;
}

/**
 * One large binary the corpus needs but does not commit.
 *
 * Two paths, because the corpus has to work before anyone has fetched
 * anything: `file` is the real document once `npm run corpus:fetch` has
 * downloaded it, `seedFile` a small committed stand-in that keeps the specs
 * runnable until then. The loader prefers the real one.
 */
export interface CorpusDocument {
  readonly name: string;
  readonly url: string;
  /**
   * Expected SHA-256 of the real document. Where it came from matters for
   * how hard to fail on a mismatch, so `sha256_source` says: `thesis-corpus`
   * values are copied from `identifiers/korpus-manifest.csv` and describe a
   * locally archived copy, which a fresh publisher download need not match
   * byte for byte; `recorded` values were observed by the recorder itself
   * and a mismatch there is a real change at the source.
   */
  readonly sha256: string | null;
  readonly sha256_source: "thesis-corpus" | "recorded" | null;
  readonly bytes: number | null;
  /** Real document, relative to `tests/corpus/` — gitignored. */
  readonly file: string;
  /** Committed stand-in, relative to `tests/corpus/`. */
  readonly seedFile?: string;
  /** Why redistributing this file is not our call to make. */
  readonly note: string;
}

export interface DocumentManifest {
  readonly documents: readonly CorpusDocument[];
}

/**
 * Removes the parts of a URL that identify the person doing the recording
 * rather than the resource: Unpaywall requires a contact address as a query
 * parameter, and a recorded corpus must not carry the recorder's mailbox
 * into the repository. Redaction happens on BOTH sides — recording and
 * replay derive the key from the redacted form — so a developer with a
 * different `TMB_UNPAYWALL_EMAIL` still hits the same cassette.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const param of ["email", "api_key", "apikey", "key", "token"]) {
    if (parsed.searchParams.has(param)) {
      parsed.searchParams.set(param, "REDACTED");
    }
  }
  return parsed.toString();
}

/**
 * Cassette key of an HTTP request. The Accept header is part of it because
 * doi.org serves entirely different representations of the same URL by
 * content negotiation — the CSL-JSON metadata and the publisher landing page
 * are one URL and two answers.
 */
export function httpCassetteKey(url: string, accept?: string): string {
  return createHash("sha256")
    .update(`GET ${redactUrl(url)}\naccept:${accept ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Cassette key of an LLM call: job kind plus the RFC 8785 canonical form of
 * the input. Reusing the register's canonicalizer rather than
 * `JSON.stringify` means key stability does not depend on property order,
 * which is exactly the guarantee the hash chain already needed.
 */
export function llmCassetteKey(method: string, params: unknown): string {
  return createHash("sha256")
    .update(`${method}\n${canonicalize(params)}`)
    .digest("hex")
    .slice(0, 32);
}
