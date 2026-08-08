import { afterEach, describe, expect, it, vi } from "vitest";

import {
  exampleProjectConfig as config,
  fakeRunner,
  jobFor,
} from "./__fixtures__/jobs";
import { UnknownBackendError } from "./core/errors";
import { resolveConfiguredBackends } from "./registry";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("resolves the API spike backend only when flag AND key are set (TMB-51)", () => {
    const apiConfig = {
      ...config,
      backends: {
        primary: { cli: "anthropic-api", model_family: "anthropic" },
      },
    };
    // Neither flag nor key: degrades exactly like an unknown cli.
    expect(() => resolveConfiguredBackends(apiConfig)).toThrow(
      UnknownBackendError,
    );
    // Flag without key stays gated.
    vi.stubEnv("TMB_ENABLE_API_BACKEND", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    expect(() => resolveConfiguredBackends(apiConfig)).toThrow(
      UnknownBackendError,
    );
    // Both present: the spike backend resolves.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect(resolveConfiguredBackends(apiConfig).primary.id).toBe(
      "anthropic-api",
    );
  });

  it("hands the injected process runner to the resolved adapters", async () => {
    const runner = fakeRunner({ exitCode: 1, stderr: "unavailable" });
    const backends = resolveConfiguredBackends(config, {
      processRunner: runner,
    });
    await backends.primary.invoke(jobFor("rubric")).catch(() => undefined);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe("claude");
  });
});
