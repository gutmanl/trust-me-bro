import { describe, expect, it } from "vitest";

import {
  CONTRACT_PAYLOAD,
  runBackendContractSuite,
} from "../../__fixtures__/contract-suite";
import { attributionJob, fakeRunner } from "../../__fixtures__/jobs";
import {
  AdapterOutputError,
  AdapterProcessError,
  AdapterRateLimitError,
} from "../../core/errors";
import { createClaudeBackend } from "./claude-backend";

const validPayload = {
  relation_type: "supports",
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

  it("reads the model from modelUsage when the envelope has no model field (observed with claude 2.1.223)", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({
        stdout: envelope({
          model: undefined,
          modelUsage: { "claude-sonnet-4-5-20250929": { inputTokens: 100 } },
        }),
      }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("reports token usage summed from modelUsage (finding 6)", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({
        stdout: envelope({
          modelUsage: {
            "claude-sonnet-4-5": { inputTokens: 100, outputTokens: 40 },
            "claude-haiku-4-5": { inputTokens: 20 },
          },
        }),
      }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
  });

  it("reports no usage when the envelope carries no modelUsage", async () => {
    const backend = createClaudeBackend({
      processRunner: fakeRunner({ stdout: envelope() }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.usage).toBeUndefined();
  });

  it("records an unresolved model as unknown, never as the backend id (S-11)", async () => {
    // This test previously asserted the opposite — that an unresolved model
    // is recorded as "claude". S-11: that made the provenance record
    // indistinguishable from a run that really used a model of that name.
    const backend = createClaudeBackend({
      processRunner: fakeRunner({ stdout: envelope({ model: undefined }) }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.model).toBe("unknown");
    expect(result.model).not.toBe("claude");
  });
});

// TMB-51: the shared taxonomy contract, translated onto claude's transport.
runBackendContractSuite({
  label: "claude",
  build(scenario) {
    const runner = (() => {
      switch (scenario.kind) {
        case "success":
          return fakeRunner({
            stdout: envelope({ result: JSON.stringify(CONTRACT_PAYLOAD) }),
          });
        case "timeout":
          return fakeRunner({ exitCode: null, timedOut: true });
        case "transport_failure":
          return fakeRunner({ exitCode: 1, stderr: scenario.detail });
        case "rate_limited":
          return fakeRunner({ exitCode: 1, stderr: scenario.detail });
        case "malformed_output":
          return fakeRunner({ stdout: envelope({ result: scenario.raw }) });
        case "schema_violation":
          return fakeRunner({
            stdout: envelope({
              result: JSON.stringify({ ...CONTRACT_PAYLOAD, confidence: 7 }),
            }),
          });
      }
    })();
    return createClaudeBackend({ processRunner: runner });
  },
});
