import type { AdapterError } from "./errors";

export interface RetryPolicy {
  /** Total attempts (first try + retries) before escalation. */
  readonly maxAttempts: number;
  /** Base of the exponential backoff between retries. */
  readonly retryBaseDelayMs: number;
}

export type AttemptDecision =
  | { readonly action: "retry"; readonly delayMs: number }
  | {
      readonly action: "paused";
      readonly reason: string;
      readonly retryAfterMs?: number;
    }
  | { readonly action: "exhausted" };

/**
 * Pure retry policy (TMB-19). Rate limits are a distinct class: they never
 * consume the retry budget and never escalate — the run pauses visibly and
 * resumably instead (Grobentwurf, Laufzeitfehler). Every other failure kind
 * retries with exponential backoff until the budget is exhausted; the caller
 * then escalates the affected claim to adjudication instead of dropping it.
 */
export function decideNextAttempt(
  error: AdapterError,
  attempt: number,
  policy: RetryPolicy,
): AttemptDecision {
  if (error.kind === "rate_limited") {
    return {
      action: "paused",
      reason: error.message,
      retryAfterMs:
        "retryAfterMs" in error
          ? (error as { retryAfterMs?: number }).retryAfterMs
          : undefined,
    };
  }
  if (attempt >= policy.maxAttempts) {
    return { action: "exhausted" };
  }
  return {
    action: "retry",
    delayMs: policy.retryBaseDelayMs * 2 ** (attempt - 1),
  };
}
