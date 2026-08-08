import fs from "node:fs";
import path from "node:path";

import {
  collectBlobPaths,
  describeBundleProblem,
  unzipBundle,
  verifyBundleFiles,
} from "../lib/export";
import { createBlobStore } from "../lib/register/blobs";
import { verifyChain } from "../lib/register/chain";
import { ClaimsRegister } from "../lib/register/schema";

export interface VerifyReport {
  ok: boolean;
  messages: string[];
}

/**
 * Verifies a project directory OR a .tmb export bundle: schema validity,
 * hash-chain gaplessness and closure, and blob integrity against the
 * snapshot checksums. Depends only on the register core and the bundle core
 * (lib/export) so it works without the web application — the Git-independent
 * verifiability the file format promises recipients of an export bundle.
 * Bundles are additionally checked against their manifest (per-file
 * checksums and the committed chain head), entirely in memory.
 */
export function runVerify(target: string): VerifyReport {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, messages: [`${target} does not exist`] };
  }
  return stat.isDirectory()
    ? runVerifyDirectory(target)
    : runVerifyBundle(target);
}

function runVerifyDirectory(projectDir: string): VerifyReport {
  const claimsPath = path.join(projectDir, "claims.json");
  if (!fs.existsSync(claimsPath)) {
    return { ok: false, messages: [`no claims.json found in ${projectDir}`] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(claimsPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      messages: [`claims.json is not valid JSON: ${String(error)}`],
    };
  }

  const parsed = ClaimsRegister.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) =>
        `  schema violation at ${issue.path.join(".") || "<root>"}: ${issue.message}`,
    );
    return {
      ok: false,
      messages: ["claims.json violates the field schema:", ...issues],
    };
  }

  const result = verifyChain(parsed.data);
  if (!result.ok) {
    const errors = result.errors.map((error) => `  ${JSON.stringify(error)}`);
    return {
      ok: false,
      messages: [
        `hash chain INVALID (${result.entryCount} entries):`,
        ...errors,
      ],
    };
  }

  // Blob integrity against the snapshot checksums (TMB-42): every blob the
  // register references must exist and hash to its path-embedded checksum.
  const blobs = createBlobStore(projectDir);
  const blobPaths = collectBlobPaths(parsed.data);
  const blobProblems = blobPaths
    .filter((blobPath) => !blobs.verifyIntegrity(blobPath))
    .map((blobPath) => `  blob missing or checksum mismatch: ${blobPath}`);
  if (blobProblems.length > 0) {
    return {
      ok: false,
      messages: ["blob integrity FAILED:", ...blobProblems],
    };
  }

  return {
    ok: true,
    messages: [
      `hash chain valid: ${result.entryCount} entries, gapless, closed to genesis`,
      `blob integrity ok: ${blobPaths.length} blob(s) match their snapshot checksums`,
    ],
  };
}

function runVerifyBundle(bundlePath: string): VerifyReport {
  let files;
  try {
    files = unzipBundle(new Uint8Array(fs.readFileSync(bundlePath)));
  } catch (error) {
    return {
      ok: false,
      messages: [`bundle is malformed: ${String(error)}`],
    };
  }

  const verification = verifyBundleFiles(files);
  if (!verification.ok) {
    return {
      ok: false,
      messages: [
        "bundle verification FAILED:",
        ...verification.problems.map(
          (problem) => `  ${describeBundleProblem(problem)}`,
        ),
      ],
    };
  }

  const blobCount = verification.manifest?.includes_blobs
    ? Object.keys(files).filter((name) => name.startsWith("blobs/")).length
    : 0;
  return {
    ok: true,
    messages: [
      `manifest ok: ${verification.manifest?.files.length ?? 0} file(s), checksums match, chain head committed`,
      `hash chain valid: ${verification.chainEntryCount} entries, gapless, closed to genesis`,
      verification.manifest?.includes_blobs
        ? `blob integrity ok: ${blobCount} blob(s) match their snapshot checksums`
        : "lean bundle: blobs as checksum references only, no blob contents to verify",
    ],
  };
}
