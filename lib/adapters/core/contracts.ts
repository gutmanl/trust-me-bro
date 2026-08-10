import type { JobIO, JobKind, JobRequest } from "./jobs";

/**
 * What one backend call resolves with: the schema-valid job output plus the
 * model that actually served the request (as reported by the backend, e.g.
 * the model field of the Claude CLI's JSON envelope — a configured alias
 * like "opus" is not enough for the provenance record).
 */
export interface InvokeResult<K extends JobKind = JobKind> {
  readonly output: JobIO[K]["output"];
  readonly model: string;
}

/**
 * Recorded as the model when a backend cannot determine which model served
 * the request (S-11).
 *
 * The alternative that used to be in place — falling back to the backend id,
 * so an unresolved model was recorded as "claude" — made the provenance
 * record look more precise than it was: a reader cannot tell a run that
 * really used a model named "claude" from one where the CLI simply did not
 * say. In a tool whose product is a trustworthy audit trail, an honest gap
 * beats a plausible-looking value.
 *
 * An English sentinel, like the enum values and actor tokens: it is stored
 * data, not display copy, and the display tier translates it.
 */
export const UNKNOWN_MODEL = "unknown";

/**
 * One LLM backend behind the adapter interface (concept: Backend-Interface,
 * extension seam 1 — an API-based backend is a further implementation of
 * this port, which is why no child-process or CLI vocabulary appears here).
 *
 * Contract: `invoke` is stateless (no session or history between calls) and
 * performs exactly ONE attempt — no retries, no fallbacks. Every failure is
 * a thrown AdapterError subclass; a resolved promise always carries a
 * schema-valid output. Retry, tracing and concurrency live in the
 * orchestrator, never in a backend.
 */
export interface Backend {
  /** Stable backend id as configured in claims.json (`backends.*.cli`). */
  readonly id: string;
  invoke<K extends JobKind>(job: JobRequest<K>): Promise<InvokeResult<K>>;
}

/** Injectable time source; the orchestrator stamps all provenance times. */
export interface Clock {
  /** ISO-8601 timestamp with offset (register IsoDateTime format). */
  now(): string;
}

export interface ProcessRunOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Written to the child's stdin, which is then closed. */
  readonly input?: string;
  readonly timeoutMs: number;
}

export interface ProcessRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Dumb child-process port: resolves with captured output and never throws or
 * interprets exit codes — mapping them to adapter errors is the concrete
 * backend's job ("no CLI-specific code outside the concrete adapters").
 * Portable spawn and timeout-kill semantics live in exactly one
 * implementation (runtime/node-process-runner).
 */
export interface ProcessRunner {
  run(options: ProcessRunOptions): Promise<ProcessRunResult>;
}

export interface HttpRequestOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** JSON request body (the port always POSTs). */
  readonly body: string;
  readonly timeoutMs: number;
}

export interface HttpResponseResult {
  /** HTTP status; null when the request failed before any response. */
  readonly status: number | null;
  readonly body: string;
  readonly timedOut: boolean;
}

/**
 * Dumb HTTP port for API-based backends (TMB-51), the transport twin of
 * ProcessRunner: resolves with the captured response and never throws or
 * interprets status codes — mapping them to adapter errors is the concrete
 * backend's job. Exactly one production implementation
 * (runtime/node-fetch-http-port) may call bare fetch.
 */
export interface HttpPort {
  request(options: HttpRequestOptions): Promise<HttpResponseResult>;
}

/** Persists one trace envelope for the given project (TMB-20). */
export interface TraceSink {
  write(
    projectDir: string,
    envelope: import("../trace/envelope").TraceEnvelope,
  ): Promise<void>;
}

/** Limits how many backend invocations run concurrently (epic TMB-2). */
export interface ConcurrencyGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}
