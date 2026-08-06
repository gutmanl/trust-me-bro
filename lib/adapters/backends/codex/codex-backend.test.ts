import { describe, expect, it } from "vitest";

import { attributionJob, fakeRunner } from "../../__fixtures__/jobs";
import {
  AdapterOutputError,
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterValidationError,
} from "../../core/errors";
import { createCodexBackend } from "./codex-backend";

const validPayload = {
  relation_type: "stuetzt",
  confidence: 0.88,
  reasoning: "Der Auszug nennt exakt die berichtete Reduktion.",
};

/** JSONL in the 0.1x event shape ({"msg":{"type":...}}). */
function classicJsonl(payload: string = JSON.stringify(validPayload)): string {
  return [
    JSON.stringify({
      id: "0",
      msg: { type: "session_configured", model: "gpt-5-codex" },
    }),
    JSON.stringify({ id: "1", msg: { type: "task_started" } }),
    JSON.stringify({
      id: "2",
      msg: { type: "agent_message", message: payload },
    }),
    JSON.stringify({ id: "3", msg: { type: "task_complete" } }),
  ].join("\n");
}

/** JSONL in the newer item.completed shape. */
function modernJsonl(payload: string = JSON.stringify(validPayload)): string {
  return [
    JSON.stringify({ type: "session.created", model: "gpt-5.1-codex" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: payload },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
}

describe("createCodexBackend", () => {
  it("invokes codex exec non-interactively, read-only sandbox, prompt via stdin, cwd = project dir", async () => {
    const runner = fakeRunner({ stdout: classicJsonl() });
    const job = attributionJob();
    await createCodexBackend({ processRunner: runner }).invoke(job);

    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0];
    expect(call.command).toBe("codex");
    expect(call.cwd).toBe(job.projectDir);
    expect(call.input).toBe(job.prompt.text);
    expect(call.timeoutMs).toBe(job.timeoutMs);
    const args = call.args.join(" ");
    expect(args).toContain("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--sandbox read-only");
    expect(args).toContain("--skip-git-repo-check");
    expect(call.args[call.args.length - 1]).toBe("-");
  });

  it("parses the classic event stream: payload from agent_message, model from session_configured", async () => {
    const backend = createCodexBackend({
      processRunner: fakeRunner({ stdout: classicJsonl() }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.output).toEqual(validPayload);
    expect(result.model).toBe("gpt-5-codex");
  });

  it("parses the modern item.completed event stream", async () => {
    const backend = createCodexBackend({
      processRunner: fakeRunner({ stdout: modernJsonl() }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.output).toEqual(validPayload);
    expect(result.model).toBe("gpt-5.1-codex");
  });

  it("uses the LAST agent message when several occur", async () => {
    const stdout = [
      classicJsonl("Let me look at the files first."),
      JSON.stringify({
        id: "9",
        msg: { type: "agent_message", message: JSON.stringify(validPayload) },
      }),
    ].join("\n");
    const backend = createCodexBackend({
      processRunner: fakeRunner({ stdout }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.output).toEqual(validPayload);
  });

  it("tolerates non-JSON lines between events", async () => {
    const stdout = ["[codex] booting…", classicJsonl()].join("\n");
    const backend = createCodexBackend({
      processRunner: fakeRunner({ stdout }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.output).toEqual(validPayload);
  });

  it("accepts a fenced JSON payload in the agent message", async () => {
    const fenced = "```json\n" + JSON.stringify(validPayload) + "\n```";
    const backend = createCodexBackend({
      processRunner: fakeRunner({ stdout: classicJsonl(fenced) }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.output).toEqual(validPayload);
  });

  it("throws AdapterOutputError when the stream has no agent message", async () => {
    const backend = createCodexBackend({
      processRunner: fakeRunner({
        stdout: JSON.stringify({ id: "0", msg: { type: "task_started" } }),
      }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterOutputError,
    );
  });

  it("throws AdapterOutputError when the agent message is not JSON", async () => {
    const backend = createCodexBackend({
      processRunner: fakeRunner({ stdout: classicJsonl("I am not sure.") }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterOutputError,
    );
  });

  it("throws AdapterValidationError when the payload violates the job schema", async () => {
    const backend = createCodexBackend({
      processRunner: fakeRunner({
        stdout: classicJsonl(
          JSON.stringify({ ...validPayload, relation_type: "supports" }),
        ),
      }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterValidationError,
    );
  });

  it("maps a rate-limited failure to AdapterRateLimitError", async () => {
    const backend = createCodexBackend({
      processRunner: fakeRunner({
        exitCode: 1,
        stderr: "ERROR: Rate limit reached. Try again in 2 hours.",
      }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterRateLimitError,
    );
  });

  it("detects a rate limit reported as an error event with exit 0", async () => {
    const stdout = JSON.stringify({
      id: "0",
      msg: { type: "error", message: "Rate limit reached for gpt-5-codex" },
    });
    const backend = createCodexBackend({
      processRunner: fakeRunner({ stdout }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterRateLimitError,
    );
  });

  it("maps other non-zero exits to AdapterProcessError", async () => {
    const backend = createCodexBackend({
      processRunner: fakeRunner({ exitCode: 2, stderr: "login required" }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterProcessError,
    );
  });

  it("maps a timeout to AdapterTimeoutError", async () => {
    const backend = createCodexBackend({
      processRunner: fakeRunner({ exitCode: null, timedOut: true }),
    });
    await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
      AdapterTimeoutError,
    );
  });

  it("falls back to the backend id when no event reports a model", async () => {
    const stdout = JSON.stringify({
      id: "1",
      msg: { type: "agent_message", message: JSON.stringify(validPayload) },
    });
    const backend = createCodexBackend({
      processRunner: fakeRunner({ stdout }),
    });
    const result = await backend.invoke(attributionJob());
    expect(result.model).toBe("codex");
  });
});
