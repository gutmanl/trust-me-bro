import { describe, expect, it } from "vitest";

import {
  CONTRACT_PAYLOAD,
  runBackendContractSuite,
} from "../../__fixtures__/contract-suite";
import { attributionJob, jobFor } from "../../__fixtures__/jobs";
import type {
  HttpPort,
  HttpRequestOptions,
  HttpResponseResult,
} from "../../core/contracts";
import { AdapterOutputError, AdapterProcessError } from "../../core/errors";
import { createAnthropicApiBackend } from "./anthropic-api-backend";

function fakeHttpPort(
  result: Partial<HttpResponseResult>,
): HttpPort & { calls: HttpRequestOptions[] } {
  const calls: HttpRequestOptions[] = [];
  return {
    calls,
    request: async (options) => {
      calls.push(options);
      return { status: 200, body: "", timedOut: false, ...result };
    },
  };
}

function messagesResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message",
    model: "claude-opus-5",
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: JSON.stringify(CONTRACT_PAYLOAD) },
    ],
    ...overrides,
  });
}

describe("createAnthropicApiBackend", () => {
  it("POSTs the rendered prompt to the Messages API with key and version headers", async () => {
    const port = fakeHttpPort({ body: messagesResponse() });
    const job = attributionJob();
    await createAnthropicApiBackend({
      apiKey: "sk-test",
      httpPort: port,
    }).invoke(job);

    expect(port.calls).toHaveLength(1);
    const call = port.calls[0];
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe("sk-test");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.timeoutMs).toBe(job.timeoutMs);
    const body = JSON.parse(call.body) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("claude-opus-5");
    expect(body.messages).toEqual([{ role: "user", content: job.prompt.text }]);
  });

  it("reports token usage from the API usage block (finding 6)", async () => {
    const backend = createAnthropicApiBackend({
      apiKey: "sk-test",
      httpPort: fakeHttpPort({
        body: messagesResponse({
          usage: { input_tokens: 512, output_tokens: 88 },
        }),
      }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.usage).toEqual({ inputTokens: 512, outputTokens: 88 });
  });

  it("reports no usage when the response omits the usage block", async () => {
    const backend = createAnthropicApiBackend({
      apiKey: "sk-test",
      httpPort: fakeHttpPort({ body: messagesResponse() }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.usage).toBeUndefined();
  });

  it("rejects job kinds outside the spike scope as invalid_output", async () => {
    const backend = createAnthropicApiBackend({
      apiKey: "sk-test",
      httpPort: fakeHttpPort({}),
    });
    await expect(backend.invoke(jobFor("extraction"))).rejects.toBeInstanceOf(
      AdapterOutputError,
    );
  });

  it("maps a network failure (no response) to AdapterProcessError", async () => {
    const backend = createAnthropicApiBackend({
      apiKey: "sk-test",
      httpPort: fakeHttpPort({
        status: null,
        body: "request failed: ECONNREFUSED",
      }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterProcessError,
    );
  });

  it("treats a safety-classifier refusal (HTTP 200) as a process failure", async () => {
    const backend = createAnthropicApiBackend({
      apiKey: "sk-test",
      httpPort: fakeHttpPort({
        body: messagesResponse({ stop_reason: "refusal", content: [] }),
      }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toMatchObject({
      kind: "process_failure",
      message: expect.stringContaining("refusal"),
    });
  });

  it("falls back to the configured model when the response reports none", async () => {
    const backend = createAnthropicApiBackend({
      apiKey: "sk-test",
      httpPort: fakeHttpPort({ body: messagesResponse({ model: undefined }) }),
      model: "claude-opus-4-8",
    });
    const result = await backend.invoke(attributionJob());
    expect(result.model).toBe("claude-opus-4-8");
  });
});

// TMB-51 acceptance: the SAME contract suite the CLI adapters pass,
// translated onto the HTTP transport.
runBackendContractSuite({
  label: "anthropic-api",
  build(scenario) {
    const port = (() => {
      switch (scenario.kind) {
        case "success":
          return fakeHttpPort({ body: messagesResponse() });
        case "timeout":
          return fakeHttpPort({ status: null, body: "", timedOut: true });
        case "transport_failure":
          return fakeHttpPort({
            status: 500,
            body: JSON.stringify({
              type: "error",
              error: { type: "api_error", message: scenario.detail },
            }),
          });
        case "rate_limited":
          return fakeHttpPort({
            status: 429,
            body: JSON.stringify({
              type: "error",
              error: { type: "rate_limit_error", message: scenario.detail },
            }),
          });
        case "malformed_output":
          return fakeHttpPort({
            body: messagesResponse({
              content: [{ type: "text", text: scenario.raw }],
            }),
          });
        case "schema_violation":
          return fakeHttpPort({
            body: messagesResponse({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ...CONTRACT_PAYLOAD, confidence: 7 }),
                },
              ],
            }),
          });
      }
    })();
    return createAnthropicApiBackend({ apiKey: "sk-test", httpPort: port });
  },
});
