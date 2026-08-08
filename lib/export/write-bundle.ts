import path from "node:path";

import { writeFileAtomic } from "../register/persistence/atomic-write";
import { assertSafeRelativePath } from "./safe-path";
import type { BundleFiles } from "./zip";

/** Bundle-only sidecars that never land in a project directory: derived
 * files are regenerable projections, the manifest describes the bundle, and
 * briefing.md is re-rendered from blob + register after import. An imported
 * project directory must be indistinguishable from a locally created one. */
const BUNDLE_ONLY = /^(manifest\.json$|derived\/|briefing\.md$)/;

/**
 * Materializes a VERIFIED bundle into a fresh project directory. Every write
 * goes through the register's atomic-write helper — the same sanctioned
 * raw-write site the trace sink uses (second ratified deep import,
 * architecture-guarded). Callers verify first; this function only copies.
 */
export function writeBundleToDirectory(
  files: BundleFiles,
  targetDir: string,
): void {
  for (const [relativePath, content] of Object.entries(files)) {
    if (BUNDLE_ONLY.test(relativePath)) {
      continue;
    }
    assertSafeRelativePath(relativePath);
    writeFileAtomic(path.join(targetDir, relativePath), Buffer.from(content));
  }
}
