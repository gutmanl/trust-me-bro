/**
 * Cross-process single-writer proof: three real OS processes append to the
 * same project concurrently; the file lock must serialize them so the chain
 * ends up gapless and valid. This is the invariant the whole file format
 * stands on — if proper-lockfile or the transaction wiring regresses (e.g.
 * on a platform change), this test catches it where in-process tests cannot.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegisterStore } from "../../lib/register";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const helper = path.join(
  repoRoot,
  "tests",
  "e2e",
  "helpers",
  "append-events.ts",
);

const PROCESSES = 3;
const EVENTS_PER_PROCESS = 5;

let projectDir: string;
let store: RegisterStore;

beforeEach(async () => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-multiproc-"));
  store = RegisterStore.atDirectory(projectDir);
  await store.create({
    id: "proj_multiprocess",
    research_question: "Serialisiert die Sperre über Prozessgrenzen?",
    config: {
      rubric_version: "se-evidenz-rubrik-v1",
      adjudication_sample_rate: 0.1,
      backends: { primary: { cli: "claude", model_family: "anthropic" } },
    },
    actor: "human:lg",
    at: "2026-08-06T08:00:00Z",
  });
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("cross-process single-writer invariant", () => {
  it(
    "keeps the chain gapless under concurrent writers in separate processes",
    { timeout: 180_000 },
    async () => {
      await Promise.all(
        Array.from({ length: PROCESSES }, (_, index) =>
          execFileAsync(
            process.execPath,
            [
              tsxCli,
              helper,
              projectDir,
              String(EVENTS_PER_PROCESS),
              `p${index}`,
            ],
            { cwd: repoRoot },
          ),
        ),
      );

      const register = await store.read();
      // 1 project_created + PROCESSES × EVENTS_PER_PROCESS batch events.
      expect(register.project_events).toHaveLength(
        1 + PROCESSES * EVENTS_PER_PROCESS,
      );
      const seqs = register.project_events
        .map((event) => event.seq)
        .sort((a, b) => a - b);
      expect(seqs).toEqual(
        Array.from(
          { length: 1 + PROCESSES * EVENTS_PER_PROCESS },
          (_, index) => index + 1,
        ),
      );
      const verification = await store.verify();
      expect(verification.errors).toEqual([]);
      expect(verification.ok).toBe(true);
    },
  );
});
