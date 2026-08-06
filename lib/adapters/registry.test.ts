import { describe, expect, it } from "vitest";

import {
  exampleProjectConfig as config,
  fakeRunner,
  jobFor,
} from "./__fixtures__/jobs";
import { UnknownBackendError } from "./core/errors";
import { resolveConfiguredBackends } from "./registry";

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
    const runner = fakeRunner({ exitCode: 1, stderr: "unavailable" });
    const backends = resolveConfiguredBackends(config, {
      processRunner: runner,
    });
    await backends.primary.invoke(jobFor("rubric")).catch(() => undefined);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe("claude");
  });
});
