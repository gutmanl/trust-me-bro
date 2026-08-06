import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProjectConfig } from "../../register";
import type { ProcessRunner } from "../core/contracts";
import { UnknownBackendError } from "../core/errors";
import type { AttributionInput, JobRequest } from "../core/jobs";
import { renderPromptForJob } from "../prompts";
import { __resetGlobalConcurrencyGateForTests } from "../runtime/concurrency-gate";
import { createProjectOrchestrator } from "./factory";

const config: ProjectConfig = {
  rubric_version: "se-evidenz-rubrik-v1",
  adjudication_sample_rate: 0.1,
  backends: {
    primary: { cli: "claude", model_family: "anthropic" },
    secondary: { cli: "codex", model_family: "openai" },
  },
};

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-factory-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalConcurrencyGateForTests();
});

describe("createProjectOrchestrator", () => {
  it("wires configured backends, file trace sink and global gate into a working orchestrator", async () => {
    const payload = {
      relation_type: "stuetzt",
      confidence: 0.9,
      reasoning: "Passt.",
    };
    const runner: ProcessRunner = {
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          is_error: false,
          result: JSON.stringify(payload),
          model: "claude-sonnet-4-5",
        }),
        stderr: "",
        timedOut: false,
      }),
    };
    const orchestrator = createProjectOrchestrator(config, {
      processRunner: runner,
    });

    const input: AttributionInput = {
      claim: {
        id: "clm_0001",
        text: "x",
        claim_type: "quantitativer_einzelbefund",
        briefing_anchor: "p1",
      },
      evidence: {
        id: "ev_0001",
        source_id: "src_meyer2025",
        locator: {},
        verbatim_excerpt: "y",
      },
    };
    const job: JobRequest<"attribution"> = {
      kind: "attribution",
      projectDir,
      input,
      prompt: renderPromptForJob("attribution", input),
      timeoutMs: 1_000,
    };

    const outcome = await orchestrator.run("claude", job);
    expect(outcome.status).toBe("ok");
    expect(fs.readdirSync(path.join(projectDir, "traces"))).toHaveLength(1);
  });

  it("rejects a config naming an unknown backend cli", () => {
    expect(() =>
      createProjectOrchestrator({
        ...config,
        backends: { primary: { cli: "gemini", model_family: "google" } },
      }),
    ).toThrow(UnknownBackendError);
  });
});
