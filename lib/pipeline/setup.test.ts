import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InvalidIdentityInputError } from "./errors";
import { completeFirstRunSetup, isSetupComplete } from "./setup";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-setup-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("isSetupComplete", () => {
  it("mirrors the identity configuration state", () => {
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    expect(isSetupComplete()).toBe(false);
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    expect(isSetupComplete()).toBe(true);
  });
});

describe("completeFirstRunSetup", () => {
  it("persists the trimmed handle and creates the workspace root", () => {
    const dir = scratch();
    const configPath = path.join(dir, "config.json");
    const workspace = path.join(dir, "workspace");
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", configPath);
    vi.stubEnv("TMB_WORKSPACE", workspace);

    completeFirstRunSetup({ actorHandle: "  lg  " });

    expect(isSetupComplete()).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).actor_handle).toBe(
      "lg",
    );
    expect(fs.existsSync(workspace)).toBe(true);
  });

  it("rejects an invalid handle with a PipelineError and writes nothing", () => {
    const dir = scratch();
    const configPath = path.join(dir, "config.json");
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", configPath);

    expect(() => completeFirstRunSetup({ actorHandle: "Löwe!" })).toThrow(
      InvalidIdentityInputError,
    );
    expect(fs.existsSync(configPath)).toBe(false);
    expect(isSetupComplete()).toBe(false);
  });
});
