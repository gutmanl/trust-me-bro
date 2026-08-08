import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Packaging build (TMB-48): runs `next build` with the standalone output
 * flag and stages the runtime assets afterwards. A plain Node script instead
 * of an inline env-var prefix so the same command works on Windows
 * (PowerShell/cmd) and POSIX shells without a cross-env dependency.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const build = spawnSync("npx", ["next", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, TMB_BUILD_TARGET: "package" },
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const stage = spawnSync(
  process.execPath,
  [path.join(repoRoot, "scripts", "prepare-standalone.mjs")],
  { cwd: repoRoot, stdio: "inherit" },
);
process.exit(stage.status ?? 1);
