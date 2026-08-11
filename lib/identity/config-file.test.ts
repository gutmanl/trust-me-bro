import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultConfigFilePath,
  isValidActorHandle,
  readConfigFile,
  writeConfigFile,
} from "./config-file";

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-config-file-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("defaultConfigFilePath", () => {
  it("prefers the TMB_CONFIG_PATH override", () => {
    vi.stubEnv("TMB_CONFIG_PATH", "./somewhere/config.json");
    expect(defaultConfigFilePath()).toBe("./somewhere/config.json");
  });

  it("defaults to ~/.trustmebro/config.json", () => {
    vi.stubEnv("TMB_CONFIG_PATH", undefined);
    expect(defaultConfigFilePath()).toBe(
      path.join(os.homedir(), ".trustmebro", "config.json"),
    );
  });
});

describe("isValidActorHandle", () => {
  it.each(["lg", "a1", "team_a", "x-y"])("accepts %j", (value) => {
    expect(isValidActorHandle(value)).toBe(true);
  });

  it.each(["", "Löwe", "UPPER", "_lead", " lg", "a b"])(
    "rejects %j",
    (value) => {
      expect(isValidActorHandle(value)).toBe(false);
    },
  );
});

describe("read/writeConfigFile", () => {
  it("round-trips handle and workspace root through snake_case JSON", () => {
    const filePath = path.join(scratchDir(), "config.json");
    writeConfigFile(filePath, { actorHandle: "lg", workspaceRoot: "./ws" });
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      config_version: 1,
      actor_handle: "lg",
      workspace_root: "./ws",
    });
    expect(readConfigFile(filePath)).toEqual({
      actorHandle: "lg",
      workspaceRoot: "./ws",
    });
  });

  it("omits the workspace root when not provided", () => {
    const filePath = path.join(scratchDir(), "config.json");
    writeConfigFile(filePath, { actorHandle: "lg" });
    expect(readConfigFile(filePath)).toEqual({
      actorHandle: "lg",
      workspaceRoot: undefined,
    });
  });

  it("creates missing parent directories on write", () => {
    const filePath = path.join(scratchDir(), "nested", "deep", "config.json");
    writeConfigFile(filePath, { actorHandle: "lg" });
    expect(readConfigFile(filePath)?.actorHandle).toBe("lg");
  });

  it("round-trips the unpaywall email alongside the other fields", () => {
    const filePath = path.join(scratchDir(), "config.json");
    writeConfigFile(filePath, {
      actorHandle: "lg",
      workspaceRoot: "./ws",
      unpaywallEmail: "lg@example.org",
    });
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      config_version: 1,
      actor_handle: "lg",
      workspace_root: "./ws",
      unpaywall_email: "lg@example.org",
    });
    expect(readConfigFile(filePath)).toEqual({
      actorHandle: "lg",
      workspaceRoot: "./ws",
      unpaywallEmail: "lg@example.org",
    });
  });

  it("omits the unpaywall email when not provided", () => {
    const filePath = path.join(scratchDir(), "config.json");
    writeConfigFile(filePath, { actorHandle: "lg" });
    expect(readConfigFile(filePath)?.unpaywallEmail).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).not.toHaveProperty(
      "unpaywall_email",
    );
  });

  it("rejects an invalid handle on write", () => {
    const filePath = path.join(scratchDir(), "config.json");
    expect(() => writeConfigFile(filePath, { actorHandle: "Nope!" })).toThrow(
      /invalid/,
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it.each([
    ["missing file", undefined],
    ["unparsable JSON", "{ not json"],
    ["wrong shape", JSON.stringify({ someone: "else" })],
    ["non-object JSON", "123"],
    ["invalid handle in file", JSON.stringify({ actor_handle: "NO" })],
  ])("degrades %s to undefined instead of throwing", (_label, content) => {
    const filePath = path.join(scratchDir(), "config.json");
    if (content !== undefined) {
      fs.appendFileSync(filePath, content, "utf8");
    }
    expect(readConfigFile(filePath)).toBeUndefined();
  });

  it("tolerates an unknown key from a newer version instead of wiping the config", () => {
    // Finding 5: a forward-compatible field written by a future build must
    // not collapse the whole file — the actor identity still parses.
    const filePath = path.join(scratchDir(), "config.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        config_version: 2,
        actor_handle: "lg",
        workspace_root: "./ws",
        some_future_field: { nested: true },
      }),
      "utf8",
    );
    expect(readConfigFile(filePath)).toEqual({
      actorHandle: "lg",
      workspaceRoot: "./ws",
      unpaywallEmail: undefined,
    });
  });

  it("reads an unversioned (pre-versioning) file as the current shape", () => {
    const filePath = path.join(scratchDir(), "config.json");
    fs.writeFileSync(filePath, JSON.stringify({ actor_handle: "lg" }), "utf8");
    expect(readConfigFile(filePath)?.actorHandle).toBe("lg");
  });
});
