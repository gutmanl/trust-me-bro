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
