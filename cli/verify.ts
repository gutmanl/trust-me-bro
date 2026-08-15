import fs from "node:fs";
import path from "node:path";

import {
  collectBlobPaths,
  describeBundleProblem,
  unzipBundle,
  verifyBundleFiles,
} from "../lib/export";
import { ClaimsRegister, createBlobStore, verifyChain } from "../lib/register";

export interface VerifyReport {
  ok: boolean;
  messages: string[];
}

/**
 * Verifies a project directory OR a .tmb export bundle: schema validity,
 * hash-chain gaplessness and closure, the materialized content state against
 * the newest entry's committed state root (where present), and blob
 * integrity against the snapshot checksums. Depends only on the register
 * core and the bundle core (lib/export) so it works without the web
 * application — the Git-independent verifiability the file format promises
 * recipients of an export bundle. Bundles are additionally checked against
 * their manifest (per-file checksums and the committed chain head), entirely
 * in memory.
 */
export function runVerify(target: string): VerifyReport {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, messages: [`${target} does not exist`] };
  }
  if (stat.isDirectory()) {
    return runVerifyDirectory(target);
  }
  // The likeliest first-use mistake: pointing at the register file itself
  // instead of its project directory. The intent is unambiguous, so verify
  // the directory (which also covers the blobs) and say so, rather than
  // reporting the JSON file as a malformed ZIP bundle.
  if (path.basename(target) === "claims.json") {
    const projectDir = path.dirname(target);
    const report = runVerifyDirectory(projectDir);
    return {
      ok: report.ok,
      messages: [
        `${target} is the register file - verifying its project directory ${projectDir}`,
        ...report.messages,
      ],
    };
  }
  return runVerifyBundle(target);
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
  // A directory from a lean import legitimately lacks the contents — the
  // report says so, but an integrity tool must not silently pass evidence
  // it cannot check, so the result is still a failure (ratified decision).
  const blobs = createBlobStore(projectDir);
  const blobPaths = collectBlobPaths(parsed.data);
  const blobProblems = blobPaths
    .filter((blobPath) => !blobs.verifyIntegrity(blobPath))
    .map((blobPath) =>
      blobs.exists(blobPath)
        ? `  blob checksum mismatch: ${blobPath}`
        : `  blob missing (lean import without blobs?): ${blobPath}`,
    );
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
      stateRootMessage(parsed.data),
      `blob integrity ok: ${blobPaths.length} blob(s) match their snapshot checksums`,
    ],
  };
}

/**
 * Names the exact content-protection scope: registers written since the
 * state-root extension have their materialized content (claim texts,
 * evidence, verification results, sources, config) replayed against the
 * newest entry's committed root; older registers are protected at the
 * entry/status level only, and the report must not imply more.
 */
function stateRootMessage(register: ClaimsRegister): string {
  let newest: { seq: number; state_root?: string } | undefined;
  for (const entry of [
    ...register.claims.flatMap((claim) => claim.history),
    ...register.project_events,
  ]) {
    if (!newest || entry.seq > newest.seq) {
      newest = entry;
    }
  }
  return newest?.state_root !== undefined
    ? `content state ok: matches the state root committed by entry ${newest.seq}`
    : "content state UNVERIFIED: legacy register from before the state-root extension (entries and status transitions are still verified)";
}

function runVerifyBundle(bundlePath: string): VerifyReport {
  let files;
  try {
    files = unzipBundle(new Uint8Array(fs.readFileSync(bundlePath)));
  } catch (error) {
    return {
      ok: false,
      messages: [
        `bundle is malformed: ${error instanceof Error ? error.message : String(error)}`,
        "hint: to verify a project, pass its directory (the folder containing claims.json)",
      ],
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
