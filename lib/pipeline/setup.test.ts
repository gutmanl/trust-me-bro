import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InvalidIdentityInputError } from "./errors";
import {
  completeFirstRunSetup,
  getActorHandleSetting,
  getUnpaywallSetting,
  getWorkspaceRootSetting,
  isSetupComplete,
  setUnpaywallEmail,
  setWorkspaceRoot,
  updateActorHandle,
} from "./setup";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-setup-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Redirects the cwd-relative default workspace ("./workspace") to a fresh
 * empty directory. Without this, a test that exercises setWorkspaceRoot with
 * neither TMB_WORKSPACE nor a stored root reads the developer's real
 * ./workspace for its "already has projects?" precondition, so a project
 * created there by ordinary use makes the test fail spuriously.
 */
function isolateDefaultWorkspace(): void {
  vi.spyOn(process, "cwd").mockReturnValue(scratch());
}

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

describe("getUnpaywallSetting / setUnpaywallEmail", () => {
  it("is unset by default", () => {
    const dir = scratch();
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", path.join(dir, "config.json"));
    expect(getUnpaywallSetting()).toEqual({ email: null, source: "unset" });
  });

  it("persists a valid address and reports it as config-sourced", async () => {
    const dir = scratch();
    const configPath = path.join(dir, "config.json");
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", configPath);

    await setUnpaywallEmail("lg@example.org");

    expect(getUnpaywallSetting()).toEqual({
      email: "lg@example.org",
      source: "config",
    });
    expect(
      JSON.parse(fs.readFileSync(configPath, "utf8")).unpaywall_email,
    ).toBe("lg@example.org");
  });

  it("clears the address with null/empty", async () => {
    const dir = scratch();
    const configPath = path.join(dir, "config.json");
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", configPath);

    await setUnpaywallEmail("lg@example.org");
    await setUnpaywallEmail("");

    expect(getUnpaywallSetting()).toEqual({ email: null, source: "unset" });
  });

  it("rejects an invalid address without writing anything", async () => {
    const dir = scratch();
    const configPath = path.join(dir, "config.json");
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", configPath);

    await expect(setUnpaywallEmail("not-an-email")).rejects.toBeInstanceOf(
      InvalidIdentityInputError,
    );
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("refuses to write when an env-provided address is currently active", async () => {
    const dir = scratch();
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", "env@example.org");
    vi.stubEnv("TMB_CONFIG_PATH", path.join(dir, "config.json"));

    await expect(setUnpaywallEmail("lg@example.org")).rejects.toBeInstanceOf(
      InvalidIdentityInputError,
    );
  });
});

describe("getWorkspaceRootSetting / setWorkspaceRoot (TMB-54, D5)", () => {
  it("reports the source so the UI knows whether it may offer an edit", () => {
    const dir = scratch();
    isolateDefaultWorkspace();
    const configPath = path.join(dir, "config.json");
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    vi.stubEnv("TMB_CONFIG_PATH", configPath);

    vi.stubEnv("TMB_WORKSPACE", undefined);
    expect(getWorkspaceRootSetting().source).toBe("default");

    setWorkspaceRoot(path.join(dir, "gewaehlt"));
    expect(getWorkspaceRootSetting()).toEqual({
      root: path.resolve(path.join(dir, "gewaehlt")),
      source: "config",
    });

    // The environment still wins over the stored value, as everywhere else.
    vi.stubEnv("TMB_WORKSPACE", path.join(dir, "aus-env"));
    expect(getWorkspaceRootSetting().source).toBe("env");
  });

  it("creates the chosen directory so the next step finds a workspace", () => {
    const dir = scratch();
    isolateDefaultWorkspace();
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    vi.stubEnv("TMB_CONFIG_PATH", path.join(dir, "config.json"));
    vi.stubEnv("TMB_WORKSPACE", undefined);

    const target = path.join(dir, "neu", "tief");
    setWorkspaceRoot(target);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("refuses an env-provided root instead of writing a value that cannot win", () => {
    const dir = scratch();
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    vi.stubEnv("TMB_CONFIG_PATH", path.join(dir, "config.json"));
    vi.stubEnv("TMB_WORKSPACE", path.join(dir, "aus-env"));

    expect(() => setWorkspaceRoot(path.join(dir, "andere"))).toThrow(
      InvalidIdentityInputError,
    );
  });

  it("rejects an empty root", () => {
    const dir = scratch();
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    vi.stubEnv("TMB_CONFIG_PATH", path.join(dir, "config.json"));
    vi.stubEnv("TMB_WORKSPACE", undefined);

    expect(() => setWorkspaceRoot("   ")).toThrow(InvalidIdentityInputError);
  });

  it("refuses to move the root once projects exist (D5: no orphaning)", () => {
    // The whole reason the workspace root is a first-run-only setting: the
    // application does not migrate project directories, so a later change
    // would leave them behind. Enforced in the use-case, not just by the
    // wizard being the only caller.
    const dir = scratch();
    isolateDefaultWorkspace();
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(path.join(workspace, "proj_alt"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "proj_alt", "claims.json"), "{}");
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    vi.stubEnv("TMB_CONFIG_PATH", path.join(dir, "config.json"));
    vi.stubEnv("TMB_WORKSPACE", undefined);
    setWorkspaceRoot(workspace);

    expect(() => setWorkspaceRoot(path.join(dir, "woanders"))).toThrow(
      /nur vor dem ersten Projekt/,
    );
    // A directory that is not a project does not block the change.
    fs.rmSync(path.join(workspace, "proj_alt"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "irgendwas"), { recursive: true });
    expect(() => setWorkspaceRoot(path.join(dir, "woanders"))).not.toThrow();
  });
});

describe("getActorHandleSetting / updateActorHandle (TMB-54, D6)", () => {
  it("reports the source and never throws on an unconfigured installation", () => {
    const dir = scratch();
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", path.join(dir, "config.json"));
    vi.stubEnv("TMB_WORKSPACE", path.join(dir, "workspace"));

    // loadIdentityConfig would throw here; the settings page needs an
    // answer instead.
    expect(getActorHandleSetting()).toEqual({ handle: null, source: "unset" });

    completeFirstRunSetup({ actorHandle: "lg" });
    expect(getActorHandleSetting()).toEqual({ handle: "lg", source: "config" });

    vi.stubEnv("TMB_ACTOR_HANDLE", "aus-env");
    expect(getActorHandleSetting().source).toBe("env");
  });

  it("changes the handle for future entries and leaves the workspace root alone", () => {
    const dir = scratch();
    isolateDefaultWorkspace();
    const configPath = path.join(dir, "config.json");
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", configPath);
    vi.stubEnv("TMB_WORKSPACE", undefined);
    completeFirstRunSetup({ actorHandle: "lg" });
    setWorkspaceRoot(path.join(dir, "workspace"));

    updateActorHandle("  neu-lg  ");

    const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(stored.actor_handle).toBe("neu-lg");
    // The unrelated field survives the write, as with every other setter.
    expect(getWorkspaceRootSetting().root).toBe(
      path.resolve(path.join(dir, "workspace")),
    );
  });

  it("rejects an invalid handle as a German PipelineError", () => {
    const dir = scratch();
    const configPath = path.join(dir, "config.json");
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", configPath);
    vi.stubEnv("TMB_WORKSPACE", path.join(dir, "workspace"));
    completeFirstRunSetup({ actorHandle: "lg" });

    expect(() => updateActorHandle("Groß Geschrieben")).toThrow(
      InvalidIdentityInputError,
    );
    // Nothing was written.
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).actor_handle).toBe(
      "lg",
    );
  });

  it("refuses to change an env-provided handle instead of writing a value that cannot win", () => {
    const dir = scratch();
    vi.stubEnv("TMB_CONFIG_PATH", path.join(dir, "config.json"));
    vi.stubEnv("TMB_WORKSPACE", path.join(dir, "workspace"));
    vi.stubEnv("TMB_ACTOR_HANDLE", "aus-env");

    expect(() => updateActorHandle("anders")).toThrow(/TMB_ACTOR_HANDLE/);
  });
});
