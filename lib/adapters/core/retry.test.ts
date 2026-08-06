import { describe, expect, it } from "vitest";

import {
  AdapterOutputError,
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
} from "./errors";
import { decideNextAttempt } from "./retry";

const config = { maxAttempts: 3, retryBaseDelayMs: 1_000 };

describe("decideNextAttempt", () => {
  it.each([
    new AdapterTimeoutError("claude", "attribution", 1),
    new AdapterProcessError("claude", "attribution", 1, "boom"),
    new AdapterOutputError("claude", "attribution", "not JSON", "prose"),
  ])(
    "retries a retryable failure with exponential backoff ($name)",
    (error) => {
      expect(decideNextAttempt(error, 1, config)).toEqual({
        action: "retry",
        delayMs: 1_000,
      });
      expect(decideNextAttempt(error, 2, config)).toEqual({
        action: "retry",
        delayMs: 2_000,
      });
    },
  );

  it("exhausts after the configured number of attempts", () => {
    const error = new AdapterTimeoutError("claude", "attribution", 1);
    expect(decideNextAttempt(error, 3, config)).toEqual({
      action: "exhausted",
    });
  });

  it("pauses on a rate limit without consuming the retry budget — even on the last attempt", () => {
    const error = new AdapterRateLimitError(
      "claude",
      "attribution",
      "usage limit reached",
      120_000,
    );
    for (const attempt of [1, 2, 3, 99]) {
      expect(decideNextAttempt(error, attempt, config)).toEqual({
        action: "paused",
        reason: error.message,
        retryAfterMs: 120_000,
      });
    }
  });

  it("treats maxAttempts=1 as fail-fast: no retry at all", () => {
    const error = new AdapterProcessError("codex", "rubric", 1, "x");
    expect(
      decideNextAttempt(error, 1, { maxAttempts: 1, retryBaseDelayMs: 1_000 }),
    ).toEqual({ action: "exhausted" });
  });
});
