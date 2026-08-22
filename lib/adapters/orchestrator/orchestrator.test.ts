import { describe, expect, it, vi } from "vitest";

import { Judgment } from "../../register";
import { jobFor } from "../__fixtures__/jobs";
import { createMockBackend } from "../backends/mock/mock-backend";
import type { ConcurrencyGate, TraceSink } from "../core/contracts";
import {
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterValidationError,
  UnknownBackendError,
} from "../core/errors";
import { TraceEnvelope } from "../trace/envelope";
import { Orchestrator } from "./orchestrator";

function capturingSink(): TraceSink & { envelopes: TraceEnvelope[] } {
  const envelopes: TraceEnvelope[] = [];
  return {
    envelopes,
    write: async (_projectDir, envelope) => {
      envelopes.push(envelope);
    },
  };
}

function orchestratorWith(
  backend = createMockBackend(),
  policy = { maxAttempts: 3, retryBaseDelayMs: 100 },
) {
  const sink = capturingSink();
  const sleeps: number[] = [];
  const counters = { gateRuns: 0 };
  const gate: ConcurrencyGate = {
    run: (fn) => {
      counters.gateRuns += 1;
      return fn();
    },
  };
  const orchestrator = new Orchestrator({
    backends: [backend],
    traceSink: sink,
    gate,
    policy,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { orchestrator, sink, sleeps, counters };
}

describe("Orchestrator.run", () => {
  it("returns ok on the first attempt and writes exactly one trace envelope", async () => {
    const { orchestrator, sink } = orchestratorWith();
    const outcome = await orchestrator.run("mock", jobFor("rubric"));
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.attempts).toBe(1);
    expect(sink.envelopes).toHaveLength(1);
    const envelope = sink.envelopes[0];
    expect(envelope.method).toBe("rubric");
    expect(envelope.backend).toBe("mock");
    expect(envelope.model).toBe("mock-1");
    expect(envelope.attempt).toBe(1);
    expect(envelope.error).toBeUndefined();
    expect(envelope.result).toBeDefined();
    expect(TraceEnvelope.safeParse(envelope).success).toBe(true);
  });

  it("stamps attribution output into a register-valid Judgment whose at equals the trace's finished_at", async () => {
    const { orchestrator, sink } = orchestratorWith();
    const outcome = await orchestrator.run("mock", jobFor("attribution"));
    if (outcome.status !== "ok")
      throw new Error(`unexpected ${outcome.status}`);
    const judgment = Judgment.parse(outcome.output);
    expect(judgment.backend).toBe("mock");
    expect(judgment.model).toBe("mock-1");
    expect(judgment.at).toBe(sink.envelopes[0].finished_at);
  });

  it("retries retryable failures with exponential backoff and traces every attempt", async () => {
    const backend = createMockBackend({
      script: [
        new AdapterTimeoutError("mock", "rubric", 1),
        new AdapterProcessError("mock", "rubric", 1, "flaky"),
        "ok",
      ],
    });
    const { orchestrator, sink, sleeps } = orchestratorWith(backend);
    const outcome = await orchestrator.run("mock", jobFor("rubric"));
    if (outcome.status !== "ok")
      throw new Error(`unexpected ${outcome.status}`);
    expect(outcome.attempts).toBe(3);
    expect(sink.envelopes).toHaveLength(3);
    expect(sink.envelopes[0].error?.kind).toBe("timeout");
    expect(sink.envelopes[1].error?.kind).toBe("process_failure");
    expect(sink.envelopes[2].result).toBeDefined();
    expect(sink.envelopes.map((envelope) => envelope.attempt)).toEqual([
      1, 2, 3,
    ]);
    expect(sleeps).toEqual([100, 200]);
  });

  it("returns exhausted with the last error once the retry budget is spent", async () => {
    const backend = createMockBackend({
      script: [
        new AdapterTimeoutError("mock", "rubric", 1),
        new AdapterTimeoutError("mock", "rubric", 1),
        new AdapterProcessError("mock", "rubric", 2, "kaputt"),
      ],
    });
    const { orchestrator, sink } = orchestratorWith(backend);
    const outcome = await orchestrator.run("mock", jobFor("rubric"));
    expect(outcome.status).toBe("exhausted");
    if (outcome.status !== "exhausted") throw new Error("unreachable");
    expect(outcome.attempts).toBe(3);
    expect(outcome.lastError).toBeInstanceOf(AdapterProcessError);
    expect(sink.envelopes).toHaveLength(3);
  });

  it("pauses immediately on a rate limit — one attempt, no sleep, no escalation", async () => {
    const backend = createMockBackend({
      script: [
        new AdapterRateLimitError("mock", "rubric", "usage limit", 60_000),
      ],
    });
    const { orchestrator, sink, sleeps } = orchestratorWith(backend);
    const outcome = await orchestrator.run("mock", jobFor("rubric"));
    expect(outcome.status).toBe("paused");
    if (outcome.status !== "paused") throw new Error("unreachable");
    expect(outcome.retryAfterMs).toBe(60_000);
    expect(outcome.attempts).toBe(1);
    expect(sleeps).toEqual([]);
    expect(sink.envelopes).toHaveLength(1);
    expect(sink.envelopes[0].error?.kind).toBe("rate_limited");
  });

  it("re-validates backend output and retries when a backend violates its contract", async () => {
    const backend = createMockBackend({
      overrides: {
        rubric: { calibration_result: "vielleicht", reasoning: "?" } as never,
      },
    });
    const { orchestrator, sink } = orchestratorWith(backend, {
      maxAttempts: 2,
      retryBaseDelayMs: 1,
    });
    const outcome = await orchestrator.run("mock", jobFor("rubric"));
    expect(outcome.status).toBe("exhausted");
    expect(sink.envelopes).toHaveLength(2);
    expect(sink.envelopes[0].error?.kind).toBe("invalid_output");
  });

  it("runs every attempt through the concurrency gate", async () => {
    const backend = createMockBackend({
      script: [new AdapterTimeoutError("mock", "rubric", 1), "ok"],
    });
    const harness = orchestratorWith(backend);
    await harness.orchestrator.run("mock", jobFor("rubric"));
    expect(harness.counters.gateRuns).toBe(2);
  });

  it("throws UnknownBackendError for an unknown backend id", async () => {
    const { orchestrator } = orchestratorWith();
    await expect(orchestrator.run("gemini", jobFor("rubric"))).rejects.toThrow(
      UnknownBackendError,
    );
  });

  it("does not lose a successful result when the trace sink fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const throwingSink: TraceSink = {
      write: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    };
    const orchestrator = new Orchestrator({
      backends: [createMockBackend()],
      traceSink: throwingSink,
      gate: { run: (fn) => fn() },
      policy: { maxAttempts: 3, retryBaseDelayMs: 1 },
      sleep: async () => undefined,
    });
    const outcome = await orchestrator.run("mock", jobFor("rubric"));
    expect(outcome.status).toBe("ok");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("trace"),
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("keeps the retry loop alive when the trace sink fails on a failed attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const throwingSink: TraceSink = {
      write: async () => {
        throw new Error("EACCES: locked by antivirus");
      },
    };
    const backend = createMockBackend({
      script: [new AdapterTimeoutError("mock", "rubric", 1), "ok"],
    });
    const orchestrator = new Orchestrator({
      backends: [backend],
      traceSink: throwingSink,
      gate: { run: (fn) => fn() },
      policy: { maxAttempts: 3, retryBaseDelayMs: 1 },
      sleep: async () => undefined,
    });
    const outcome = await orchestrator.run("mock", jobFor("rubric"));
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.attempts).toBe(2);
    warn.mockRestore();
  });
});

/**
 * The INPUT-DEPENDENT half of the boundary (03-02), at the orchestrator.
 *
 * This is what makes PROMPT-01's word "retryable" true for a clause that
 * `validateJobOutput` structurally cannot decide: it must reach the SAME
 * catch, consume the SAME retry budget and end in the SAME `exhausted`
 * outcome as any other schema failure — no new error class, no new row in
 * the taxonomy, no rejected promise.
 */
describe("Orchestrator.run — assertOutputMatchesInput", () => {
  /** There is no attribution v1.2.0 template yet (03-03 authors it); the
   * version gate reads `job.prompt.version` and nothing else. */
  function twoLayerAttributionJob() {
    const base = jobFor("attribution");
    return { ...base, prompt: { ...base.prompt, version: "1.2.0" } };
  }

  it("retries a persistently anchorless attribution output to exhausted, carrying an AdapterValidationError", async () => {
    const backend = createMockBackend({
      overrides: {
        attribution: {
          relation_type: "supports",
          confidence: 0.9,
          reasoning_plain: "Der Auszug trägt die Aussage. Die Richtung passt.",
          caveat: null,
          reasoning_technical:
            "Der Abschnitt deckt die Aussage in ihrem Kontext vollständig ab.",
        },
      },
    });
    const { orchestrator, sink } = orchestratorWith(backend);

    const outcome = await orchestrator.run("mock", twoLayerAttributionJob());

    expect(outcome.status).toBe("exhausted");
    if (outcome.status !== "exhausted") throw new Error("unreachable");
    expect(outcome.attempts).toBe(3);
    expect(outcome.lastError).toBeInstanceOf(AdapterValidationError);
    expect(outcome.lastError.kind).toBe("invalid_output");
    // Every failed attempt is still traced — the escalation is auditable.
    expect(sink.envelopes).toHaveLength(3);
  });

  it("lets an anchored attribution output through on the first attempt", async () => {
    const backend = createMockBackend({
      overrides: {
        attribution: {
          relation_type: "supports",
          confidence: 0.9,
          reasoning_plain: "Der Auszug trägt die Aussage. Die Richtung passt.",
          caveat: null,
          reasoning_technical:
            'Der Abschnitt sagt "median review time dropped from 42 to 19 ' +
            'minutes" und deckt die Aussage ab.',
        },
      },
    });
    const { orchestrator } = orchestratorWith(backend);

    const outcome = await orchestrator.run("mock", twoLayerAttributionJob());

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.attempts).toBe(1);
    // Provenance is still stamped from code, and the pipeline — not the
    // orchestrator — will join the three prose fields into the register's
    // Judgment.
    expect(outcome.output.backend).toBe("mock");
    expect(outcome.output).not.toHaveProperty("reasoning");
  });

  it("leaves a legacy-version attribution job entirely untouched", async () => {
    // Every existing project renders attribution v1.1.0. If the clause ran
    // there, every judgment they produce would escalate.
    const { orchestrator } = orchestratorWith();
    const outcome = await orchestrator.run("mock", jobFor("attribution"));
    expect(outcome.status).toBe("ok");
  });
});
