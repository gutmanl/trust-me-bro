import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "../register";
import type { ProcessRunOptions, ProcessRunner } from "./core/contracts";
import { UnknownBackendError } from "./core/errors";
import { resolveConfiguredBackends } from "./registry";

const config: ProjectConfig = {
  rubric_version: "se-evidenz-rubrik-v1",
  adjudication_sample_rate: 0.1,
  backends: {
    primary: { cli: "claude", model_family: "anthropic" },
    secondary: { cli: "codex", model_family: "openai" },
  },
};

describe("resolveConfiguredBackends", () => {
  it("maps backends.primary/secondary from claims.json config to concrete adapters", () => {
    const backends = resolveConfiguredBackends(config);
    expect(backends.primary.id).toBe("claude");
    expect(backends.secondary?.id).toBe("codex");
  });

  it("returns no secondary when the config has none (divergence rule disabled)", () => {
    const backends = resolveConfiguredBackends({
      ...config,
      backends: { primary: config.backends.primary },
    });
    expect(backends.secondary).toBeUndefined();
  });

  it("throws UnknownBackendError for an unregistered cli value", () => {
    expect(() =>
      resolveConfiguredBackends({
        ...config,
        backends: { primary: { cli: "gemini", model_family: "google" } },
      }),
    ).toThrow(UnknownBackendError);
  });

  it("hands the injected process runner to the resolved adapters", async () => {
    const calls: ProcessRunOptions[] = [];
    const runner: ProcessRunner = {
      run: async (options) => {
        calls.push(options);
        return {
          exitCode: 1,
          stdout: "",
          stderr: "unavailable",
          timedOut: false,
        };
      },
    };
    const backends = resolveConfiguredBackends(config, {
      processRunner: runner,
    });
    await backends.primary
      .invoke({
        kind: "rubric",
        projectDir: "C:/tmp/proj_x",
        input: {
          claim: {
            id: "clm_0001",
            text: "x",
            claim_type: "empfehlung",
            briefing_anchor: "p1",
          },
          evidence: [],
          rubric_version: "v1",
        },
        prompt: {
          version: "1.0.0",
          template_sha256: "0".repeat(64),
          text: "t",
        },
        timeoutMs: 10,
      })
      .catch(() => undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("claude");
  });
});
