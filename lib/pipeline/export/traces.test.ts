import { describe, expect, it } from "vitest";

import type { TraceEnvelope } from "../../adapters";
import { summarizeTraces } from "./traces";

function trace(over: Partial<TraceEnvelope>): TraceEnvelope {
  return {
    started_at: "2026-08-11T10:00:00.000+02:00",
    finished_at: "2026-08-11T10:00:02.000+02:00",
    ...over,
  } as TraceEnvelope;
}

describe("summarizeTraces (finding 6)", () => {
  it("sums duration and token usage across attempts", () => {
    const summary = summarizeTraces([
      trace({
        finished_at: "2026-08-11T10:00:03.000+02:00", // 3 s
        usage: { input_tokens: 100, output_tokens: 40 },
      }),
      trace({
        finished_at: "2026-08-11T10:00:01.500+02:00", // 1.5 s
        usage: { input_tokens: 50 },
      }),
    ]);
    expect(summary).toEqual({
      attempts: 2,
      failedAttempts: 0,
      totalDurationMs: 4500,
      inputTokens: 150,
      outputTokens: 40,
      usageReported: true,
    });
  });

  it("counts failed attempts and marks usage unreported when none carry it", () => {
    const summary = summarizeTraces([
      trace({
        error: {
          kind: "process_failure",
          name: "AdapterProcessError",
          message: "boom",
        },
      }),
      trace({}),
    ]);
    expect(summary.attempts).toBe(2);
    expect(summary.failedAttempts).toBe(1);
    expect(summary.usageReported).toBe(false);
    expect(summary.inputTokens).toBeUndefined();
    expect(summary.outputTokens).toBeUndefined();
  });

  it("is empty for a project with no traces", () => {
    expect(summarizeTraces([])).toEqual({
      attempts: 0,
      failedAttempts: 0,
      totalDurationMs: 0,
      usageReported: false,
    });
  });
});
