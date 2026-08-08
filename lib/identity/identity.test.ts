import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeConfigFile } from "./config-file";
import {
  getCurrentActor,
  getWorkspaceRoot,
  IdentityNotConfiguredError,
  isIdentityConfigured,
  loadAdapterConfig,
  loadIdentityConfig,
  resolveProjectDir,
  writeIdentityConfig,
} from "./index";

const scratchDirs: string[] = [];

function scratchConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-identity-"));
  scratchDirs.push(dir);
  return path.join(dir, "config.json");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadIdentityConfig", () => {
  it("throws when neither environment nor config file supplies a kuerzel", () => {
    vi.stubEnv("TMB_ACTOR_KUERZEL", undefined);
    vi.stubEnv("TMB_WORKSPACE", undefined);
    expect(() => loadIdentityConfig()).toThrow(IdentityNotConfiguredError);
  });

  it("reads kuerzel and workspace root from the environment", () => {
    vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
    vi.stubEnv("TMB_WORKSPACE", "./tmp/ws");
    const config = loadIdentityConfig();
    expect(config.actorKuerzel).toBe("lg");
    expect(config.workspaceRoot).toBe(path.resolve("./tmp/ws"));
  });

  it("defaults the workspace root when only the kuerzel is configured", () => {
    vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
    vi.stubEnv("TMB_WORKSPACE", undefined);
    expect(loadIdentityConfig().workspaceRoot).toBe(
      path.resolve("./workspace"),
    );
  });

  it("reads the stored config file when the environment is unset", () => {
    const filePath = scratchConfigPath();
    writeConfigFile(filePath, {
      actorKuerzel: "aus_datei",
      workspaceRoot: "./tmp/file-ws",
    });
    vi.stubEnv("TMB_ACTOR_KUERZEL", undefined);
    vi.stubEnv("TMB_WORKSPACE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    const config = loadIdentityConfig();
    expect(config.actorKuerzel).toBe("aus_datei");
    expect(config.workspaceRoot).toBe(path.resolve("./tmp/file-ws"));
  });

  it("lets the environment override the stored config file", () => {
    const filePath = scratchConfigPath();
    writeConfigFile(filePath, { actorKuerzel: "aus_datei" });
    vi.stubEnv("TMB_ACTOR_KUERZEL", "env-wins");
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    expect(loadIdentityConfig().actorKuerzel).toBe("env-wins");
  });

  it("treats a corrupt config file as unconfigured", () => {
    const filePath = scratchConfigPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, "{ not json", "utf8");
    vi.stubEnv("TMB_ACTOR_KUERZEL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    expect(() => loadIdentityConfig()).toThrow(IdentityNotConfiguredError);
  });

  it("rejects a kuerzel outside the allowed ASCII subset", () => {
    vi.stubEnv("TMB_ACTOR_KUERZEL", "Löwe!");
    expect(() => loadIdentityConfig()).toThrow(/TMB_ACTOR_KUERZEL/);
  });
});

describe("isIdentityConfigured", () => {
  it("is false when neither environment nor config file exists", () => {
    vi.stubEnv("TMB_ACTOR_KUERZEL", undefined);
    expect(isIdentityConfigured()).toBe(false);
  });

  it("is true via the environment alone", () => {
    vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
    expect(isIdentityConfigured()).toBe(true);
  });

  it("is true via the stored config file alone", () => {
    const filePath = scratchConfigPath();
    writeConfigFile(filePath, { actorKuerzel: "lg" });
    vi.stubEnv("TMB_ACTOR_KUERZEL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    expect(isIdentityConfigured()).toBe(true);
  });
});

describe("writeIdentityConfig", () => {
  it("persists the kuerzel and returns the now-effective identity", () => {
    const filePath = scratchConfigPath();
    vi.stubEnv("TMB_ACTOR_KUERZEL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    const config = writeIdentityConfig({ actorKuerzel: "lg" });
    expect(config.actorKuerzel).toBe("lg");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(loadIdentityConfig().actorKuerzel).toBe("lg");
  });

  it("keeps an env override effective directly after setup", () => {
    const filePath = scratchConfigPath();
    vi.stubEnv("TMB_ACTOR_KUERZEL", "env-wins");
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    expect(writeIdentityConfig({ actorKuerzel: "lg" }).actorKuerzel).toBe(
      "env-wins",
    );
  });
});

describe("getCurrentActor", () => {
  it("formats the actor id as human:<kuerzel>", () => {
    vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
    expect(getCurrentActor()).toBe("human:lg");
  });
});

describe("loadAdapterConfig", () => {
  it("falls back to code defaults when nothing is configured", () => {
    const config = loadAdapterConfig();
    expect(config).toEqual({
      timeoutMs: 300_000,
      maxAttempts: 3,
      retryBaseDelayMs: 2_000,
      maxConcurrency: 2,
    });
  });

  it("reads every TMB_ADAPTER_* variable from the environment", () => {
    vi.stubEnv("TMB_ADAPTER_TIMEOUT_MS", "60000");
    vi.stubEnv("TMB_ADAPTER_MAX_ATTEMPTS", "1");
    vi.stubEnv("TMB_ADAPTER_RETRY_BASE_DELAY_MS", "500");
    vi.stubEnv("TMB_ADAPTER_MAX_CONCURRENCY", "4");
    expect(loadAdapterConfig()).toEqual({
      timeoutMs: 60_000,
      maxAttempts: 1,
      retryBaseDelayMs: 500,
      maxConcurrency: 4,
    });
  });

  it.each([
    ["TMB_ADAPTER_TIMEOUT_MS", "0"],
    ["TMB_ADAPTER_TIMEOUT_MS", "-5"],
    ["TMB_ADAPTER_MAX_ATTEMPTS", "none"],
    ["TMB_ADAPTER_MAX_CONCURRENCY", "1.5"],
  ])("rejects an invalid %s=%s", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => loadAdapterConfig()).toThrow(new RegExp(name));
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
