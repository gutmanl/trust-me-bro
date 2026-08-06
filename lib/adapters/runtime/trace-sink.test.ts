import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TraceEnvelope } from "../trace/envelope";
import { fileTraceSink } from "./trace-sink";

function envelope(overrides: Partial<TraceEnvelope> = {}): TraceEnvelope {
  return TraceEnvelope.parse({
    trace_id: "0f8b7c1e-1234-4abc-9def-000000000001",
    method: "attribution",
    params: { claim: "clm_0001" },
    backend: "mock",
    model: "mock-1",
    prompt_version: "1.0.0",
    prompt_sha256: "a".repeat(64),
    attempt: 1,
    started_at: "2026-08-06T15:30:00.123Z",
    finished_at: "2026-08-06T15:30:21.456Z",
    result: { relation_type: "stuetzt" },
    ...overrides,
  });
}

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-trace-sink-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("fileTraceSink", () => {
  it("writes one immutable JSON file per envelope into traces/", async () => {
    await fileTraceSink.write(projectDir, envelope());
    const files = fs.readdirSync(path.join(projectDir, "traces"));
    expect(files).toHaveLength(1);
    const content = fs.readFileSync(
      path.join(projectDir, "traces", files[0]),
      "utf8",
    );
    expect(content.endsWith("\n")).toBe(true);
    expect(TraceEnvelope.parse(JSON.parse(content))).toEqual(envelope());
  });

  it("names files sortably by start time with the trace id, without NTFS-hostile characters", async () => {
    await fileTraceSink.write(projectDir, envelope());
    const [file] = fs.readdirSync(path.join(projectDir, "traces"));
    expect(file).toBe(
      "20260806T153000123Z--0f8b7c1e-1234-4abc-9def-000000000001.json",
    );
    expect(file).not.toMatch(/[:*?"<>|]/);
  });

  it("keeps every attempt as its own file — retried calls do not overwrite", async () => {
    await fileTraceSink.write(projectDir, envelope());
    await fileTraceSink.write(
      projectDir,
      envelope({
        trace_id: "0f8b7c1e-1234-4abc-9def-000000000002",
        attempt: 2,
        result: undefined,
        error: { kind: "timeout", name: "AdapterTimeoutError", message: "x" },
      }),
    );
    expect(fs.readdirSync(path.join(projectDir, "traces"))).toHaveLength(2);
  });

  it("rejects an envelope that violates the trace schema", async () => {
    const invalid = {
      ...envelope(),
      error: { kind: "timeout", name: "AdapterTimeoutError", message: "x" },
    };
    await expect(
      fileTraceSink.write(projectDir, invalid as TraceEnvelope),
    ).rejects.toThrow(/result and error/);
  });
});
