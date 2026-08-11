import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "../../register";
import { BackendUnavailableError } from "../errors";
import { buildProjectOrchestrator } from "./build-orchestrator";

function config(primaryCli: string): ProjectConfig {
  return {
    rubric_version: "se-evidence-rubric-v1",
    adjudication_sample_rate: 0,
    backends: { primary: { cli: primaryCli, model_family: "anthropic" } },
    second_opinion: {
      confidence_threshold: 0.8,
      on_relation_not_supports: true,
    },
  } as unknown as ProjectConfig;
}

describe("buildProjectOrchestrator", () => {
  it("builds an orchestrator for a known backend", () => {
    expect(() => buildProjectOrchestrator(config("claude"))).not.toThrow();
  });

  it("translates an unknown backend into a German precondition error", () => {
    try {
      buildProjectOrchestrator(config("nope"));
      throw new Error("expected a BackendUnavailableError");
    } catch (error) {
      expect(error).toBeInstanceOf(BackendUnavailableError);
      expect((error as Error).message).toContain("nope");
      expect((error as Error).message).toContain("nicht verfügbar");
    }
  });
});
