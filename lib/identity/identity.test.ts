import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeConfigFile } from "./config-file";
import {
  getCurrentActor,
  getUnpaywallEmail,
  getUnpaywallSetting,
  getWorkspaceRoot,
  IdentityNotConfiguredError,
  isIdentityConfigured,
  loadAdapterConfig,
  loadAnthropicApiKey,
  loadFeatureFlags,
  loadIdentityConfig,
  resolveProjectDir,
  writeIdentityConfig,
  writeUnpaywallEmail,
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
  it("throws when neither environment nor config file supplies a handle", () => {
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_WORKSPACE", undefined);
    expect(() => loadIdentityConfig()).toThrow(IdentityNotConfiguredError);
  });

  it("reads handle and workspace root from the environment", () => {
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    vi.stubEnv("TMB_WORKSPACE", "./tmp/ws");
    const config = loadIdentityConfig();
    expect(config.actorHandle).toBe("lg");
    expect(config.workspaceRoot).toBe(path.resolve("./tmp/ws"));
  });

  it("defaults the workspace root when only the handle is configured", () => {
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    vi.stubEnv("TMB_WORKSPACE", undefined);
    expect(loadIdentityConfig().workspaceRoot).toBe(
      path.resolve("./workspace"),
    );
  });

  it("reads the stored config file when the environment is unset", () => {
    const filePath = scratchConfigPath();
    writeConfigFile(filePath, {
      actorHandle: "aus_datei",
      workspaceRoot: "./tmp/file-ws",
    });
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_WORKSPACE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    const config = loadIdentityConfig();
    expect(config.actorHandle).toBe("aus_datei");
    expect(config.workspaceRoot).toBe(path.resolve("./tmp/file-ws"));
  });

  it("lets the environment override the stored config file", () => {
    const filePath = scratchConfigPath();
    writeConfigFile(filePath, { actorHandle: "aus_datei" });
    vi.stubEnv("TMB_ACTOR_HANDLE", "env-wins");
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    expect(loadIdentityConfig().actorHandle).toBe("env-wins");
  });

  it("treats a corrupt config file as unconfigured", () => {
    const filePath = scratchConfigPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, "{ not json", "utf8");
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    expect(() => loadIdentityConfig()).toThrow(IdentityNotConfiguredError);
  });

  it("rejects a handle outside the allowed ASCII subset", () => {
    vi.stubEnv("TMB_ACTOR_HANDLE", "Löwe!");
    expect(() => loadIdentityConfig()).toThrow(/TMB_ACTOR_HANDLE/);
  });
});

describe("isIdentityConfigured", () => {
  it("is false when neither environment nor config file exists", () => {
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    expect(isIdentityConfigured()).toBe(false);
  });

  it("is true via the environment alone", () => {
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    expect(isIdentityConfigured()).toBe(true);
  });

  it("is true via the stored config file alone", () => {
    const filePath = scratchConfigPath();
    writeConfigFile(filePath, { actorHandle: "lg" });
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    expect(isIdentityConfigured()).toBe(true);
  });
});

describe("writeIdentityConfig", () => {
  it("persists the handle and returns the now-effective identity", () => {
    const filePath = scratchConfigPath();
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    const config = writeIdentityConfig({ actorHandle: "lg" });
    expect(config.actorHandle).toBe("lg");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(loadIdentityConfig().actorHandle).toBe("lg");
  });

  it("keeps an env override effective directly after setup", () => {
    const filePath = scratchConfigPath();
    vi.stubEnv("TMB_ACTOR_HANDLE", "env-wins");
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    expect(writeIdentityConfig({ actorHandle: "lg" }).actorHandle).toBe(
      "env-wins",
    );
  });

  it("preserves an existing unpaywallEmail and workspaceRoot instead of dropping them (C1)", () => {
    const filePath = scratchConfigPath();
    writeConfigFile(filePath, {
      actorHandle: "old",
      workspaceRoot: "./ws",
      unpaywallEmail: "lg@example.org",
    });
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);

    writeIdentityConfig({ actorHandle: "new" });

    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(onDisk).toEqual({
      config_version: 1,
      actor_handle: "new",
      workspace_root: "./ws",
      unpaywall_email: "lg@example.org",
    });
  });
});

describe("feature flags (TMB-51)", () => {
  it("keeps the API backend off by default", () => {
    vi.stubEnv("TMB_ENABLE_API_BACKEND", undefined);
    expect(loadFeatureFlags().apiBackendEnabled).toBe(false);
  });

  it("enables the API backend only on the explicit value 1", () => {
    vi.stubEnv("TMB_ENABLE_API_BACKEND", "true");
    expect(loadFeatureFlags().apiBackendEnabled).toBe(false);
    vi.stubEnv("TMB_ENABLE_API_BACKEND", "1");
    expect(loadFeatureFlags().apiBackendEnabled).toBe(true);
  });

  it("treats a missing or empty API key as absent", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    expect(loadAnthropicApiKey()).toBeUndefined();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(loadAnthropicApiKey()).toBeUndefined();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect(loadAnthropicApiKey()).toBe("sk-test");
  });
});

describe("getCurrentActor", () => {
  it("formats the actor id as human:<handle>", () => {
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
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

describe("getUnpaywallSetting / getUnpaywallEmail", () => {
  it("is unset when neither the environment nor the config file supplies an address", () => {
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", scratchConfigPath());
    expect(getUnpaywallSetting()).toEqual({ email: null, source: "unset" });
    expect(getUnpaywallEmail()).toBeNull();
  });

  it("reads the address from the stored config file", () => {
    const filePath = scratchConfigPath();
    writeConfigFile(filePath, {
      actorHandle: "lg",
      unpaywallEmail: "lg@example.org",
    });
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    expect(getUnpaywallSetting()).toEqual({
      email: "lg@example.org",
      source: "config",
    });
    expect(getUnpaywallEmail()).toBe("lg@example.org");
  });

  it("lets the environment override the stored config file", () => {
    const filePath = scratchConfigPath();
    writeConfigFile(filePath, {
      actorHandle: "lg",
      unpaywallEmail: "aus-datei@example.org",
    });
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", "env-wins@example.org");
    vi.stubEnv("TMB_CONFIG_PATH", filePath);
    expect(getUnpaywallSetting()).toEqual({
      email: "env-wins@example.org",
      source: "env",
    });
  });
});

describe("writeUnpaywallEmail", () => {
  it("persists the address and preserves the existing workspace root", () => {
    const filePath = scratchConfigPath();
    writeConfigFile(filePath, { actorHandle: "lg", workspaceRoot: "./ws" });
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);

    writeUnpaywallEmail("lg@example.org");

    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      config_version: 1,
      actor_handle: "lg",
      workspace_root: "./ws",
      unpaywall_email: "lg@example.org",
    });
    expect(getUnpaywallEmail()).toBe("lg@example.org");
  });

  it("clears the address with null while preserving the other fields", () => {
    const filePath = scratchConfigPath();
    writeConfigFile(filePath, {
      actorHandle: "lg",
      workspaceRoot: "./ws",
      unpaywallEmail: "lg@example.org",
    });
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);

    writeUnpaywallEmail(null);

    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      config_version: 1,
      actor_handle: "lg",
      workspace_root: "./ws",
    });
    expect(getUnpaywallEmail()).toBeNull();
  });

  it("carries the env-provided actor handle into a newly created file", () => {
    const filePath = scratchConfigPath();
    vi.stubEnv("TMB_ACTOR_HANDLE", "env-lg");
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", filePath);

    writeUnpaywallEmail("lg@example.org");

    expect(fs.existsSync(filePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).actor_handle).toBe(
      "env-lg",
    );
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
