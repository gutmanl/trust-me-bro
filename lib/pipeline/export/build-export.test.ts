import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unzipBundle, verifyBundleFiles } from "../../export";
import { importBriefing } from "../briefing";
import { createProject } from "../projects";
import { captureSource } from "../sources/capture";
import { fakeFetcher } from "../sources/__fixtures__/fake-fetcher";
import { exportProjectBundle } from "./build-export";

const PROJECT = "proj_export";

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-export-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
  await importBriefing({
    projectId: PROJECT,
    content: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
    tool: "deep-research-x",
  });
  await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "peer_reviewed_publication",
      manual: { title: "Studie", authors: "Studie, A." },
      upload: {
        content: Buffer.from(
          "median review time dropped from 42 to 19 minutes",
        ),
        filename: "studie.txt",
      },
    },
    { fetcher: fakeFetcher({}) },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

describe("exportProjectBundle (TMB-39)", () => {
  it("builds a self-verifying bundle with byte-identical claims.json", async () => {
    const result = await exportProjectBundle(PROJECT, { includeBlobs: true });
    expect(result.filename).toMatch(
      /^trustmebro-export_proj_export_\d{8}T\d{6}\d{3}Z\.tmb$/,
    );

    const files = unzipBundle(result.bytes);
    for (const expected of [
      "manifest.json",
      "claims.json",
      "briefing.md",
      "schema/claims.schema.json",
      "derived/references.csl.json",
      "derived/prov.jsonld",
      "derived/traces.json",
    ]) {
      expect(files[expected], expected).toBeDefined();
    }
    expect(
      Object.keys(files).filter((name) => name.startsWith("blobs/")).length,
    ).toBeGreaterThan(0);

    // The bundle's claims.json is the verbatim on-disk file.
    const onDisk = fs.readFileSync(
      path.join(workspace, PROJECT, "claims.json"),
    );
    expect(Buffer.compare(Buffer.from(files["claims.json"]), onDisk)).toBe(0);

    // Manifest checksums match every contained file; chain closes.
    const verification = verifyBundleFiles(files);
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.manifest?.project).toEqual({
      inner_id: PROJECT,
      directory_name: PROJECT,
    });
  });

  it("builds a lean bundle with checksum references instead of blobs", async () => {
    const result = await exportProjectBundle(PROJECT, { includeBlobs: false });
    const files = unzipBundle(result.bytes);
    expect(
      Object.keys(files).filter((name) => name.startsWith("blobs/")),
    ).toEqual([]);

    const verification = verifyBundleFiles(files);
    expect(verification.problems).toEqual([]);
    expect(verification.manifest?.includes_blobs).toBe(false);
    const excluded = verification.manifest!.files.filter(
      (entry) => !entry.included,
    );
    expect(excluded.length).toBeGreaterThan(0);
    for (const entry of excluded) {
      expect(entry.path).toMatch(/^blobs\//);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
