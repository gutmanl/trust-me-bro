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
