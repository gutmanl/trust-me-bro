import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getCurrentActor,
  getWorkspaceRoot,
  loadIdentityConfig,
  resolveProjectDir,
} from "./index";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadIdentityConfig", () => {
  it("falls back to defaults when nothing is configured", () => {
    vi.stubEnv("TMB_ACTOR_KUERZEL", undefined);
    vi.stubEnv("TMB_WORKSPACE", undefined);
    const config = loadIdentityConfig();
    expect(config.actorKuerzel).toBe("user");
    expect(config.workspaceRoot).toBe(path.resolve("./workspace"));
  });

  it("reads kuerzel and workspace root from the environment", () => {
    vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
    vi.stubEnv("TMB_WORKSPACE", "./tmp/ws");
    const config = loadIdentityConfig();
    expect(config.actorKuerzel).toBe("lg");
    expect(config.workspaceRoot).toBe(path.resolve("./tmp/ws"));
  });

  it("rejects a kuerzel outside the allowed ASCII subset", () => {
    vi.stubEnv("TMB_ACTOR_KUERZEL", "Löwe!");
    expect(() => loadIdentityConfig()).toThrow(/TMB_ACTOR_KUERZEL/);
  });
});

describe("getCurrentActor", () => {
  it("formats the actor id as human:<kuerzel>", () => {
    vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
    expect(getCurrentActor()).toBe("human:lg");
  });
});

describe("resolveProjectDir", () => {
  it("joins the project id onto the workspace root", () => {
    vi.stubEnv("TMB_WORKSPACE", "./tmp/ws");
    expect(resolveProjectDir("proj_llm-code-review-2026")).toBe(
      path.join(getWorkspaceRoot(), "proj_llm-code-review-2026"),
    );
  });

  it.each(["../escape", "a/b", "a\\b", ".hidden", ""])(
    "rejects unsafe project id %j",
    (projectId) => {
      expect(() => resolveProjectDir(projectId)).toThrow(/invalid/);
    },
  );
});
