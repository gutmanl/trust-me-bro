import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChainAppender } from "../lib/register/chain";
import type { ClaimsRegister } from "../lib/register/schema";
import exampleProject from "../lib/register/schema/__fixtures__/example-project.json";
import { runVerify } from "./verify";

let projectDir: string;

/** Rebuilds the fixture's chain via ChainAppender so it is gapless and closed
 * (the appendix example intentionally elides seq 3–7). */
function chainedFixture(): ClaimsRegister {
  const register = structuredClone(exampleProject) as unknown as ClaimsRegister;
  const historyEntries = register.claims[0].history;
  const [frozen] = register.project_events;
  register.claims[0].history = [];
  register.project_events = [];
  const appender = new ChainAppender(register);
  register.project_events.push(
    appender.append({
      ...frozen,
      seq: undefined,
      prev_hash: undefined,
      hash: undefined,
    }) as never,
  );
  for (const entry of historyEntries) {
    register.claims[0].history.push(
      appender.append({
        ...entry,
        seq: undefined,
        prev_hash: undefined,
        hash: undefined,
      }) as never,
    );
  }
  return register;
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-verify-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function writeClaims(register: ClaimsRegister): void {
  fs.writeFileSync(
    path.join(projectDir, "claims.json"),
    JSON.stringify(register, null, 2),
  );
}

describe("tmb verify", () => {
  it("reports a valid project as ok", () => {
    writeClaims(chainedFixture());
    const report = runVerify(projectDir);
    expect(report.messages.join("\n")).toContain("gapless");
    expect(report.ok).toBe(true);
  });

  it("reports a tampered entry as chain violation", () => {
    const register = chainedFixture();
    register.claims[0].history[0].reason = "manipuliert";
    writeClaims(register);
    const report = runVerify(projectDir);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("hash_mismatch");
  });

  it("reports schema violations before chain checks", () => {
    const register = chainedFixture() as Record<string, unknown>;
    register.schema_version = "0.0.1";
    writeClaims(register as unknown as ClaimsRegister);
    const report = runVerify(projectDir);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("schema violation");
  });

  it("fails cleanly on a missing claims.json", () => {
    const report = runVerify(projectDir);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("no claims.json");
  });
});
