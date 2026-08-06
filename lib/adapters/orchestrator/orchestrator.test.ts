import { describe, expect, it } from "vitest";

import { Judgment } from "../../register";
import { createMockBackend } from "../backends/mock/mock-backend";
import type { ConcurrencyGate, TraceSink } from "../core/contracts";
import {
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  UnknownBackendError,
} from "../core/errors";
import type { JobKind, JobRequest } from "../core/jobs";
import { renderPromptForJob } from "../prompts";
import { TraceEnvelope } from "../trace/envelope";
import { Orchestrator } from "./orchestrator";

const claim = {
  id: "clm_0001",
  text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
  claim_type: "quantitativer_einzelbefund",
  briefing_anchor: "p12",
} as const;

const evidence = {
  id: "ev_0001",
  source_id: "src_meyer2025",
  locator: { page: 6 },
  verbatim_excerpt: "…median review time dropped…",
} as const;

function jobFor<K extends JobKind>(kind: K): JobRequest<K> {
  const inputs = {
    extraction: {
      research_question: "Frage?",
      briefing_text: "Briefing",
      sources: [{ id: "src_meyer2025", citation: "Meyer (2025)" }],
    },
    attribution: { claim, evidence },
    rubric: {
      claim,
      evidence: [evidence],
      rubric_version: "se-evidenz-rubrik-v1",
    },
    repair: {
      claim,
      evidence: [evidence],
      complaint: { category: null, reason: "Zu stark formuliert." },
    },
  } as const;
  const input = inputs[kind] as JobRequest<K>["input"];
  return {
    kind,
    projectDir: "C:/tmp/proj_x",
    input,
    prompt: renderPromptForJob(kind, input),
    timeoutMs: 1_000,
  };
}

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
});
