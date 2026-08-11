import type { ZodError } from "zod";

import type { JobKind } from "./jobs";

/**
 * Failure taxonomy of the adapter layer. The `kind` drives the retry policy:
 * `timeout`, `process_failure` and `invalid_output` consume the bounded retry
 * budget and eventually escalate the claim to adjudication; `rate_limited`
 * is deliberately distinct — it never consumes retries and never escalates,
 * it pauses the run visibly and resumably (Grobentwurf, CLI-Robustheit).
 */
export type AdapterErrorKind =
  "timeout" | "process_failure" | "invalid_output" | "rate_limited";

export abstract class AdapterError extends Error {
  abstract readonly kind: AdapterErrorKind;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AdapterTimeoutError extends AdapterError {
  readonly kind = "timeout" as const;
  constructor(
    readonly backend: string,
    readonly jobKind: JobKind,
    readonly timeoutMs: number,
  ) {
    super(
      `${backend} timed out after ${timeoutMs}ms on job "${jobKind}" (child process killed)`,
    );
  }
}

export class AdapterProcessError extends AdapterError {
  readonly kind = "process_failure" as const;
  constructor(
    readonly backend: string,
    readonly jobKind: JobKind,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `${backend} exited with code ${exitCode === null ? "null" : exitCode} on job "${jobKind}": ${stderr.slice(0, 500)}`,
    );
  }
}

/** The backend produced output that is not the requested JSON payload. */
export class AdapterOutputError extends AdapterError {
  readonly kind = "invalid_output" as const;
  constructor(
    readonly backend: string,
    readonly jobKind: JobKind,
    reason: string,
    readonly rawOutput: string,
    options?: { cause?: unknown },
  ) {
    super(`${backend} produced unusable output on job "${jobKind}": ${reason}`);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** The output parsed as JSON but violates the job's result schema. */
export class AdapterValidationError extends AdapterError {
  readonly kind = "invalid_output" as const;
  constructor(
    readonly backend: string,
    readonly jobKind: JobKind,
    readonly zodError: ZodError,
  ) {
    super(
      `${backend} output on job "${jobKind}" fails schema validation: ${zodError.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")
        .slice(0, 500)}`,
    );
  }
}

/**
 * Configuration error, not an invoke failure: claims.json names a backend
 * cli this build has no adapter for. Deliberately outside the AdapterError
 * hierarchy — it must never be retried or traced as an attempt.
 */
export class UnknownBackendError extends Error {
  constructor(readonly cli: string) {
    super(`no adapter is registered for backend cli "${cli}"`);
    this.name = "UnknownBackendError";
  }
}

export class AdapterRateLimitError extends AdapterError {
  readonly kind = "rate_limited" as const;
  constructor(
    readonly backend: string,
    readonly jobKind: JobKind,
    readonly detail: string,
    readonly retryAfterMs?: number,
  ) {
    super(
      `${backend} signaled a rate limit on job "${jobKind}": ${detail.slice(0, 300)}`,
    );
  }
}
