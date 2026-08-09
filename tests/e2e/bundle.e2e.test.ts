/**
 * End-to-end test of the export epic (TMB-6): a real project is exported as
 * a .tmb bundle, verified by the REAL tmb CLI as a separate process (intact
 * and tampered), imported back under a new workspace name, and the imported
 * directory passes the same CLI — the Git-independent verifiability the
 * file format promises recipients, in executable form.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bundleText, unzipBundle, zipBundle } from "../../lib/export";
import { importBriefing } from "../../lib/pipeline/briefing";
import { exportProjectBundle } from "../../lib/pipeline/export/build-export";
import { importProjectBundle } from "../../lib/pipeline/export/import-bundle";
import { createProject } from "../../lib/pipeline/projects";
import {
  captureSource,
  freezeSourceSet,
} from "../../lib/pipeline/sources/capture";
import { fakeFetcher } from "../../lib/pipeline/sources/__fixtures__/fake-fetcher";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

let workspace: string;

async function runCli(
  target: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [tsxCli, path.join(repoRoot, "cli", "tmb.ts"), "verify", target],
      { cwd: repoRoot, env },
    );
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "" };
  }
}

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-bundle-e2e-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: "proj_bundle-e2e",
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
  await importBriefing({
    projectId: "proj_bundle-e2e",
    content: "Die mediane Reviewzeit sinkt laut einer Studie um 55 %.",
    tool: "deep-research-x",
  });
  await captureSource(
    {
      projectId: "proj_bundle-e2e",
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
  await freezeSourceSet("proj_bundle-e2e");
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

describe("export → CLI verify → import roundtrip", () => {
  it(
    "verifies intact and rejects tampered bundles through the real CLI",
    { timeout: 120_000 },
    async () => {
      const cliEnv = { ...process.env, TMB_WORKSPACE: workspace };

      // Intact directory and intact bundle both pass.
      const projectDir = path.join(workspace, "proj_bundle-e2e");
      const goodDir = await runCli(projectDir, cliEnv);
      expect(goodDir.stdout).toContain("blob integrity ok");
      expect(goodDir.code).toBe(0);

      const bundle = await exportProjectBundle("proj_bundle-e2e", {
        includeBlobs: true,
      });
      const bundlePath = path.join(workspace, bundle.filename);
      fs.writeFileSync(bundlePath, Buffer.from(bundle.bytes));
      const goodBundle = await runCli(bundlePath, cliEnv);
      expect(goodBundle.stdout).toContain("manifest ok");
      expect(goodBundle.code).toBe(0);

      // A tampered bundle (silent claims.json edit, manifest untouched)
      // exits non-zero and names the violation.
      const files = unzipBundle(new Uint8Array(bundle.bytes));
      files["claims.json"] = bundleText.encode(
        bundleText
          .decode(files["claims.json"])
          .replace("Reviewzeit", "Bearbeitungszeit"),
      );
      const tamperedPath = path.join(workspace, "tampered.tmb");
      fs.writeFileSync(
        tamperedPath,
        Buffer.from(zipBundle(files, "2026-08-08T12:00:00Z")),
      );
      const badBundle = await runCli(tamperedPath, cliEnv);
      expect(badBundle.code).toBe(1);
      expect(badBundle.stdout).toContain("Prüfsumme");

      // Import the intact bundle under a new name; the imported directory
      // passes the same CLI, byte-identical claims.json included.
      await importProjectBundle({
        bytes: Buffer.from(bundle.bytes),
        targetDirectoryName: "proj_bundle-kopie",
      });
      const importedDir = path.join(workspace, "proj_bundle-kopie");
      expect(
        Buffer.compare(
          fs.readFileSync(path.join(importedDir, "claims.json")),
          fs.readFileSync(path.join(projectDir, "claims.json")),
        ),
      ).toBe(0);
      const importedReport = await runCli(importedDir, cliEnv);
      expect(importedReport.stdout).toContain("blob integrity ok");
      expect(importedReport.code).toBe(0);
    },
  );
});
