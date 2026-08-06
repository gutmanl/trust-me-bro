import { describe, expect, it } from "vitest";

import { nodeProcessRunner } from "./node-process-runner";

/**
 * These tests spawn real OS processes — but only Node itself, never an agent
 * CLI, so they run in CI on both Ubuntu and Windows (the two platforms have
 * different kill semantics, which is exactly what this file pins down).
 */
const node = process.execPath;

describe("nodeProcessRunner", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await nodeProcessRunner.run({
      command: node,
      args: ["-e", "console.log('hello from child')"],
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("hello from child");
  });

  it("captures stderr and a non-zero exit code", async () => {
    const result = await nodeProcessRunner.run({
      command: node,
      args: ["-e", "console.error('boom'); process.exit(3)"],
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
  });

  it("pipes input to the child's stdin and closes it", async () => {
    const result = await nodeProcessRunner.run({
      command: node,
      args: [
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log('got:'+d)})",
      ],
      cwd: process.cwd(),
      input: "prompt text",
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("got:prompt text");
  });

  it("runs the child in the requested working directory", async () => {
    const result = await nodeProcessRunner.run({
      command: node,
      args: ["-e", "console.log(process.cwd())"],
      cwd: import.meta.dirname,
      timeoutMs: 30_000,
    });
    expect(result.stdout.trim()).toBe(import.meta.dirname);
  });

  it(
    "kills a hanging child on timeout and reports timedOut",
    { timeout: 20_000 },
    async () => {
      const startedAt = Date.now();
      const result = await nodeProcessRunner.run({
        command: node,
        args: ["-e", "setTimeout(() => {}, 60_000)"],
        cwd: process.cwd(),
        timeoutMs: 500,
      });
      expect(result.timedOut).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    },
  );

  it("resolves instead of throwing when the command does not exist", async () => {
    const result = await nodeProcessRunner.run({
      command: "tmb-definitely-not-installed-xyz",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });
});
