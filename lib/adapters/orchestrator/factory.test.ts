import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  exampleProjectConfig as config,
  fakeRunner,
  jobFor,
} from "../__fixtures__/jobs";
import { UnknownBackendError } from "../core/errors";
import { __resetGlobalConcurrencyGateForTests } from "../runtime/concurrency-gate";
import { createProjectOrchestrator } from "./factory";

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-factory-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalConcurrencyGateForTests();
});

describe("createProjectOrchestrator", () => {
  it("wires configured backends, file trace sink and global gate into a working orchestrator", async () => {
    const payload = {
      relation_type: "stuetzt",
      confidence: 0.9,
      reasoning: "Passt.",
    };
    const runner = fakeRunner({
      stdout: JSON.stringify({
        is_error: false,
        result: JSON.stringify(payload),
        model: "claude-sonnet-4-5",
      }),
    });
    const orchestrator = createProjectOrchestrator(config, {
      processRunner: runner,
    });

    const outcome = await orchestrator.run(
      "claude",
      jobFor("attribution", projectDir),
    );
    expect(outcome.status).toBe("ok");
    expect(fs.readdirSync(path.join(projectDir, "traces"))).toHaveLength(1);
  });

  it("rejects a config naming an unknown backend cli", () => {
    expect(() =>
      createProjectOrchestrator({
        ...config,
        backends: { primary: { cli: "gemini", model_family: "google" } },
      }),
    ).toThrow(UnknownBackendError);
  });
});
