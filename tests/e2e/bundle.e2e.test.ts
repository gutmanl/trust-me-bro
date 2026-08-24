/**
 * End-to-end test of the export epic (TMB-6): a real project is exported as
 * a .tmb bundle, verified by the REAL tmb CLI as a separate process (intact
 * and tampered), imported back under a new workspace name, and the imported
 * directory passes the same CLI — the Git-independent verifiability the
 * file format promises recipients, in executable form.
 */
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  bundleText,
  MANIFEST_VERSION,
  unzipBundle,
  zipBundle,
} from "../../lib/export";
import { RegisterStore } from "../../lib/register";
import { importBriefing } from "../../lib/pipeline/briefing";
import { exportProjectBundle } from "../../lib/pipeline/export/build-export";
import { importProjectBundle } from "../../lib/pipeline/export/import-bundle";
import { createProject } from "../../lib/pipeline/projects";
import { captureSource } from "../../lib/pipeline/sources/capture";
import { fakeFetcher } from "../../lib/pipeline/sources/__fixtures__/fake-fetcher";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
// The compiled artifact the tarball ships as the `tmb` bin — see the note in
// lifecycle.e2e.test.ts.
const compiledCli = path.join(repoRoot, "dist", "cli", "tmb.js");

let workspace: string;

// `npx vitest run <path>` bypasses npm lifecycle hooks, so the build has to
// happen here.
beforeAll(() => {
  const build = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "build-cli.mjs")],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (build.status !== 0) {
    throw new Error("CLI build failed");
  }
}, 180_000);

async function runCli(
  target: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [compiledCli, "verify", target],
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

describe("reviewer-triggered re-verification: bundle round-trip both ways", () => {
  it(
    "a register carrying the new calibration fields exports, verifies and imports",
    { timeout: 120_000 },
    async () => {
      const cliEnv = { ...process.env, TMB_WORKSPACE: workspace };
      const projectDir = path.join(workspace, "proj_bundle-e2e");
      const store = RegisterStore.forProject("proj_bundle-e2e");

      // Mint a real, chain-linked claim through the sanctioned capability.
      await store.transaction((tx) => {
        tx.addClaim({
          claim: {
            id: "clm_0001",
            text: "Die mediane Reviewzeit sinkt um 55 %.",
            claim_type: "quantitative_finding",
            briefing_anchor: "p1",
            provenance: {
              tool: "deep-research-x",
              model: "deep-research-x-1",
              extracted_at: "2026-08-20T08:00:00Z",
              search_path: "Suchlauf 1",
            },
            evidence: [],
          },
          actor: "system:extraction",
          reason: "Aus Briefing-Absatz p1 extrahiert.",
        });
      });

      // Both new fields are written through the PRODUCTION capabilities
      // (04-02 replaced 04-01's direct-injection placeholder here): two
      // ordinary `setCalibrationResult` calls, the second of which rotates
      // the first outcome into `previous_calibrations` by itself, and the
      // bracket pair through `recordReverificationRun`. The round-trip
      // therefore proves the shape a real re-run actually leaves on disk,
      // not a hand-built approximation of it.
      const registerPath = path.join(projectDir, "claims.json");
      await store.transaction((tx) => {
        tx.setSupportDegree("clm_0001", "supported");
        tx.setCalibrationResult(
          "clm_0001",
          "licensed",
          "Zahlenwert und Richtung stimmen ueberein.",
          "1.0.0",
        );
      });
      await store.transaction((tx) => {
        tx.setCalibrationResult(
          "clm_0001",
          "weakened",
          "Der Auszug nennt die Richtung, nicht die Groessenordnung.",
          "1.1.0",
        );
        tx.recordReverificationRun({
          claim_ids: ["clm_0001"],
          actor: "human:lg",
          started_reason: "Erneute Pruefung von 1 Aussage angefordert.",
          completed_reason:
            "Erneute Pruefung angefordert; 1 Aussage zurueckgesetzt.",
        });
      });
      const rotated = (await store.read()).claims[0];
      expect(rotated.previous_calibrations).toHaveLength(1);
      expect(rotated.previous_calibrations?.[0].calibration_result).toBe(
        "licensed",
      );

      // The directory verifies with the new fields in place.
      const dirReport = await runCli(projectDir, cliEnv);
      expect(dirReport.stdout).toContain("blob integrity ok");
      expect(dirReport.code).toBe(0);

      // Export → the bundle carries them → CLI verify passes on the bundle.
      const bundle = await exportProjectBundle("proj_bundle-e2e", {
        includeBlobs: true,
      });
      const files = unzipBundle(new Uint8Array(bundle.bytes));
      const bundledRegister = bundleText.decode(files["claims.json"]);
      expect(bundledRegister).toContain("previous_calibrations");
      expect(bundledRegister).toContain("calibration_prompt_version");
      expect(bundledRegister).toContain("reverification_run_started");
      expect(bundleText.decode(files["manifest.json"])).toContain(
        `"manifest_version": "${MANIFEST_VERSION}"`,
      );

      const bundlePath = path.join(workspace, bundle.filename);
      fs.writeFileSync(bundlePath, Buffer.from(bundle.bytes));
      const bundleReport = await runCli(bundlePath, cliEnv);
      expect(bundleReport.stdout).toContain("manifest ok");
      expect(bundleReport.code).toBe(0);

      // Import it back under a new name; claims.json survives byte-identical.
      await importProjectBundle({
        bytes: Buffer.from(bundle.bytes),
        targetDirectoryName: "proj_bundle-neu",
      });
      const importedDir = path.join(workspace, "proj_bundle-neu");
      expect(
        Buffer.compare(
          fs.readFileSync(path.join(importedDir, "claims.json")),
          fs.readFileSync(registerPath),
        ),
      ).toBe(0);
      const importedReport = await runCli(importedDir, cliEnv);
      expect(importedReport.code).toBe(0);
    },
  );

  it(
    "a bundle written before the extension still verifies and imports after it",
    { timeout: 120_000 },
    async () => {
      const cliEnv = { ...process.env, TMB_WORKSPACE: workspace };

      // Nothing here has ever written the new fields — the same content a
      // register produced before this extension carries.
      const bundle = await exportProjectBundle("proj_bundle-e2e", {
        includeBlobs: true,
      });
      const files = unzipBundle(new Uint8Array(bundle.bytes));
      const bundledRegister = bundleText.decode(files["claims.json"]);
      expect(bundledRegister).not.toContain("previous_calibrations");
      expect(bundledRegister).not.toContain("calibration_prompt_version");
      expect(bundledRegister).not.toContain("reverification_run");
      expect(bundleText.decode(files["manifest.json"])).toContain(
        `"manifest_version": "${MANIFEST_VERSION}"`,
      );

      const bundlePath = path.join(workspace, bundle.filename);
      fs.writeFileSync(bundlePath, Buffer.from(bundle.bytes));
      const bundleReport = await runCli(bundlePath, cliEnv);
      expect(bundleReport.stdout).toContain("manifest ok");
      expect(bundleReport.code).toBe(0);

      await importProjectBundle({
        bytes: Buffer.from(bundle.bytes),
        targetDirectoryName: "proj_bundle-alt",
      });
      const importedReport = await runCli(
        path.join(workspace, "proj_bundle-alt"),
        cliEnv,
      );
      expect(importedReport.stdout).toContain("blob integrity ok");
      expect(importedReport.code).toBe(0);
    },
  );
});
