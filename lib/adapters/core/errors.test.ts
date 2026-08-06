import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AdapterError,
  AdapterOutputError,
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterValidationError,
} from "./errors";

describe("adapter error hierarchy", () => {
  it("classifies timeouts as retryable", () => {
    const error = new AdapterTimeoutError("claude", "attribution", 120_000);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.name).toBe("AdapterTimeoutError");
    expect(error.kind).toBe("timeout");
    expect(error.message).toMatch(/claude.*120000ms.*attribution/);
  });

  it("keeps exit code and stderr on process failures", () => {
    const error = new AdapterProcessError("codex", "rubric", 1, "boom");
    expect(error.kind).toBe("process_failure");
    expect(error.exitCode).toBe(1);
    expect(error.stderr).toBe("boom");
    expect(error.message).toMatch(/codex.*exited.*1.*rubric/);
  });

  it("reports a null exit code (killed process) readably", () => {
    const error = new AdapterProcessError("claude", "repair", null, "");
    expect(error.message).toMatch(/exited with code null/);
  });

  it("keeps the raw output on unparseable results", () => {
    const error = new AdapterOutputError(
      "claude",
      "extraction",
      "not valid JSON",
      "I could not find any claims.",
    );
    expect(error.kind).toBe("invalid_output");
    expect(error.rawOutput).toBe("I could not find any claims.");
    expect(error.message).toMatch(/claude.*extraction.*not valid JSON/);
  });

  it("summarizes zod issues on schema violations", () => {
    const parsed = z
      .strictObject({ confidence: z.number().max(1) })
      .safeParse({ confidence: 2 });
    if (parsed.success) throw new Error("fixture must fail");
    const error = new AdapterValidationError(
      "codex",
      "attribution",
      parsed.error,
    );
    expect(error.kind).toBe("invalid_output");
    expect(error.zodError).toBe(parsed.error);
    expect(error.message).toMatch(/confidence/);
  });

  it("keeps rate limits distinct from every retryable kind", () => {
    const error = new AdapterRateLimitError(
      "claude",
      "attribution",
      "429",
      60_000,
    );
    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(60_000);
    const retryableKinds = [
      new AdapterTimeoutError("claude", "attribution", 1),
      new AdapterProcessError("claude", "attribution", 1, ""),
      new AdapterOutputError("claude", "attribution", "x", ""),
    ].map((retryable) => retryable.kind);
    expect(retryableKinds).not.toContain(error.kind);
  });

  it("truncates very long stderr in the message but keeps it complete on the field", () => {
    const longStderr = "x".repeat(2_000);
    const error = new AdapterProcessError("claude", "rubric", 2, longStderr);
    expect(error.stderr).toHaveLength(2_000);
    expect(error.message.length).toBeLessThan(1_000);
  });
});
