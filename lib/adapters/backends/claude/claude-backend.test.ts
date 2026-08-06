import { describe, expect, it } from "vitest";

import type {
  ProcessRunOptions,
  ProcessRunResult,
  ProcessRunner,
} from "../../core/contracts";
import {
  AdapterOutputError,
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterValidationError,
} from "../../core/errors";
import type { AttributionInput, JobRequest } from "../../core/jobs";
import { renderPromptForJob } from "../../prompts";
import { createClaudeBackend } from "./claude-backend";

const attributionInput: AttributionInput = {
  claim: {
    id: "clm_0001",
    text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
    claim_type: "quantitativer_einzelbefund",
    briefing_anchor: "p12",
  },
  evidence: {
    id: "ev_0001",
    source_id: "src_meyer2025",
    locator: { page: 6 },
    verbatim_excerpt: "…median review time dropped…",
  },
};

function attributionJob(): JobRequest<"attribution"> {
  return {
    kind: "attribution",
    projectDir: "C:/tmp/proj_x",
    input: attributionInput,
    prompt: renderPromptForJob("attribution", attributionInput),
    timeoutMs: 90_000,
  };
}

const validPayload = {
  relation_type: "stuetzt",
  confidence: 0.92,
  reasoning: "Zahlenwert und Richtung stimmen überein.",
};

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(validPayload),
    model: "claude-sonnet-4-5",
    session_id: "00000000-0000-0000-0000-000000000000",
    ...overrides,
  });
}

function fakeRunner(
  result: Partial<ProcessRunResult>,
): ProcessRunner & { calls: ProcessRunOptions[] } {
  const calls: ProcessRunOptions[] = [];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...result,
      };
    },
  };
}

describe("createClaudeBackend", () => {
  it("invokes claude -p headless, read-only, hermetic, prompt via stdin, cwd = project dir", async () => {
    const runner = fakeRunner({ stdout: envelope() });
    const job = attributionJob();
    await createClaudeBackend({ processRunner: runner }).invoke(job);

    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0];
    expect(call.command).toBe("claude");
    expect(call.cwd).toBe(job.projectDir);
    expect(call.input).toBe(job.prompt.text);
    expect(call.timeoutMs).toBe(job.timeoutMs);
    const args = call.args.join(" ");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format json");
    expect(args).toContain("--permission-mode dontAsk");
    expect(args).toContain("--allowedTools Read,Glob,Grep");
    expect(args).toContain("--setting-sources project");
    expect(args).toContain("--strict-mcp-config");
  });

  it("parses the envelope and returns the validated payload with the reported model", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({ stdout: envelope() }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.output).toEqual(validPayload);
    expect(result.model).toBe("claude-sonnet-4-5");
  });

  it("accepts a result payload wrapped in a markdown fence", async () => {
    const fenced = "```json\n" + JSON.stringify(validPayload) + "\n```";
    const backend = createClaudeBackend({
      processRunner: fakeRunner({ stdout: envelope({ result: fenced }) }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.output).toEqual(validPayload);
  });

  it("prefers structured_output when the envelope carries one", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({
        stdout: envelope({
          result: "explanatory prose",
          structured_output: validPayload,
        }),
      }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.output).toEqual(validPayload);
  });

  it("throws AdapterOutputError when stdout is not a JSON envelope", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({ stdout: "Execution error" }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterOutputError,
    );
  });

  it("throws AdapterOutputError when the result payload is not JSON", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({
        stdout: envelope({ result: "I found no evidence." }),
      }),
    });
    const rejection = expect(backend.invoke(attributionJob())).rejects;
    await rejection.toBeInstanceOf(AdapterOutputError);
  });

  it("throws AdapterValidationError when the payload violates the job schema", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({
        stdout: envelope({
          result: JSON.stringify({ ...validPayload, confidence: 7 }),
        }),
      }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterValidationError,
    );
  });

  it("maps an is_error envelope with a limit message to AdapterRateLimitError", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({
        stdout: envelope({
          is_error: true,
          result: "5-hour usage limit reached · resets at 22:00",
        }),
      }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterRateLimitError,
    );
  });

  it("maps other is_error envelopes to AdapterProcessError", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({
        stdout: envelope({ is_error: true, result: "authentication failed" }),
      }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterProcessError,
    );
  });

  it("maps a non-zero exit with a 429 on stderr to AdapterRateLimitError", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({
        exitCode: 1,
        stderr: "API Error: 429 Too Many Requests",
      }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterRateLimitError,
    );
  });

  it("maps other non-zero exits to AdapterProcessError with stderr preserved", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({
        exitCode: 1,
        stderr: "spawn failed: ENOENT",
      }),
    });
    const promise = backend.invoke(attributionJob());
    await expect(promise).rejects.toBeInstanceOf(AdapterProcessError);
    await expect(promise).rejects.toMatchObject({
      stderr: expect.stringContaining("ENOENT"),
    });
  });

  it("maps a timeout to AdapterTimeoutError", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({ exitCode: null, timedOut: true }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterTimeoutError,
    );
  });

  it("falls back to the backend id when the envelope reports no model", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({ stdout: envelope({ model: undefined }) }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.model).toBe("claude");
  });
});
