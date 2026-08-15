import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCliVersion, runCli } from "./main";
import type { CliIo } from "./main";

/**
 * First-contact behavior of the bin itself: someone who has never seen the
 * tool will try `tmb`, `tmb --help` and `tmb --version` before anything
 * else, and the exit codes are what a script or CI step keys on.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

let scratchDir: string;

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-cli-main-"));
});

afterEach(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (message) => out.push(message),
      err: (message) => err.push(message),
    },
    out,
    err,
  };
}

describe("runCli: help and version", () => {
  it.each(["--help", "-h", "help"])(
    "prints usage to stdout and exits 0 for %s",
    (flag) => {
      const { io, out, err } = capture();
      expect(runCli([flag], io)).toBe(0);
      expect(out.join("\n")).toContain("usage: tmb verify");
      expect(out.join("\n")).toContain("exit codes");
      expect(err).toEqual([]);
    },
  );

  it.each(["--version", "-V", "version"])(
    "prints the package version and exits 0 for %s",
    (flag) => {
      const { io, out } = capture();
      expect(runCli([flag], io, here)).toBe(0);
      expect(out.join("\n")).toMatch(/^tmb \(trustmebro\) \d+\.\d+\.\d+$/);
    },
  );

  it("still exits 0 with a nameless version line when no package.json is found", () => {
    const { io, out } = capture();
    expect(runCli(["--version"], io, scratchDir)).toBe(0);
    expect(out).toEqual(["tmb (trustmebro)"]);
  });
});

describe("runCli: usage errors", () => {
  it.each([
    [[], "no arguments"],
    [["verify"], "verify without a target"],
    [["verify", "a", "b"], "verify with two targets"],
    [["frobnicate", "x"], "an unknown command"],
  ])("prints usage to stderr and exits 2 for %j (%s)", (argv) => {
    const { io, out, err } = capture();
    expect(runCli(argv as string[], io)).toBe(2);
    expect(err.join("\n")).toContain("usage: tmb verify");
    expect(out).toEqual([]);
  });
});

describe("runCli: verify wiring", () => {
  it("exits 1 and reports when the target does not exist", () => {
    const { io, out } = capture();
    const target = path.join(scratchDir, "nirgendwo");
    expect(runCli(["verify", target], io)).toBe(1);
    expect(out.join("\n")).toContain("does not exist");
  });
});

describe("readCliVersion", () => {
  it("finds the repo's own package.json from the cli directory", () => {
    const version = readCliVersion(here);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("walks past package.json files that belong to other packages", () => {
    // Layout an installed-like tree: <root>/package.json (trustmebro) with
    // a nested foreign package.json between it and the start directory.
    fs.writeFileSync(
      path.join(scratchDir, "package.json"),
      JSON.stringify({ name: "trustmebro", version: "9.9.9" }),
    );
    const nested = path.join(scratchDir, "node_modules", "other");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(nested, "package.json"),
      JSON.stringify({ name: "other", version: "1.0.0" }),
    );
    expect(readCliVersion(nested)).toBe("9.9.9");
  });

  it("returns undefined when nothing above the start directory matches", () => {
    expect(readCliVersion(scratchDir)).toBeUndefined();
  });

  it("keeps walking past an unreadable package.json", () => {
    fs.writeFileSync(
      path.join(scratchDir, "package.json"),
      JSON.stringify({ name: "trustmebro", version: "3.3.3" }),
    );
    const nested = path.join(scratchDir, "broken");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "package.json"), "{ not json");
    expect(readCliVersion(nested)).toBe("3.3.3");
  });
});
