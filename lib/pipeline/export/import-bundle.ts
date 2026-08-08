import fs from "node:fs";

import {
  BundleFormatError,
  describeBundleProblem,
  unzipBundle,
  verifyBundleFiles,
  writeBundleToDirectory,
} from "../../export";
import { resolveProjectDir } from "../../identity";
import { RegisterStore } from "../../register";
import {
  InvalidBundleError,
  InvalidProjectInputError,
  ProjectAlreadyExistsError,
} from "../errors";

/**
 * TMB-40: imports a received .tmb bundle as a NEW project in the workspace.
 * The user chooses the target directory name (ratified decision): the
 * chain-bound inner project id in claims.json is immutable — genesis hash
 * over id, research question and creation time — so the workspace name is
 * routing identity only, and the two may diverge for imported projects.
 *
 * Verification happens entirely in memory BEFORE any write (manifest
 * checksums, field schema, hash chain, chain head, blob integrity — the
 * same core `tmb verify` uses); a failing bundle aborts with the itemized
 * diagnosis and leaves no directory behind. The chain continues from the
 * imported tip on the next regular transaction — claims.json lands
 * byte-identical, nothing is appended by the import itself.
 */

export interface ImportBundleResult {
  directoryName: string;
  innerProjectId: string;
}

export async function importProjectBundle(input: {
  bytes: Buffer;
  targetDirectoryName: string;
}): Promise<ImportBundleResult> {
  const directoryName = input.targetDirectoryName.trim();
  if (directoryName.length === 0) {
    throw new InvalidProjectInputError(
      "Bitte einen Verzeichnisnamen für das importierte Projekt angeben.",
    );
  }
  let targetDir: string;
  try {
    targetDir = resolveProjectDir(directoryName);
  } catch {
    throw new InvalidProjectInputError(
      `Verzeichnisname "${directoryName}" ist ungültig: erwartet werden ` +
        `Kleinbuchstaben, Ziffern, ".", "_" oder "-" (nicht mit "." beginnend).`,
    );
  }
  if (fs.existsSync(targetDir)) {
    throw new ProjectAlreadyExistsError(directoryName);
  }

  let files;
  try {
    files = unzipBundle(new Uint8Array(input.bytes));
  } catch (error) {
    if (error instanceof BundleFormatError) {
      throw new InvalidBundleError([error.message]);
    }
    throw error;
  }
  const verification = verifyBundleFiles(files);
  if (!verification.ok || !verification.register) {
    throw new InvalidBundleError(
      verification.problems.map(describeBundleProblem),
    );
  }

  writeBundleToDirectory(files, targetDir);

  // briefing.md is a regenerable projection: re-render it from the frozen
  // blob. A lean bundle (blobs as checksum references) has no briefing blob
  // to render from — the projection simply stays absent, a documented
  // consequence of the "ohne Blobs" variant.
  const store = RegisterStore.atDirectory(targetDir);
  if (verification.register.project.briefing_import) {
    try {
      await store.renderBriefingFile();
    } catch {
      // best-effort: the register (source of truth) is complete either way
    }
  }

  return {
    directoryName,
    innerProjectId: verification.register.project.id,
  };
}
