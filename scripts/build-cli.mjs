import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Compiles the `tmb` CLI and its dependency closure to plain CommonJS
 * JavaScript under dist/. The published tarball ships that output as the
 * `tmb` bin, so the CLI no longer needs tsx (a devDependency, absent from an
 * installed package) to run. A plain Node script instead of an inline shell
 * command so the same invocation works on Windows and POSIX shells.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const build = spawnSync("npx", ["tsc", "-p", "tsconfig.cli.json"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(build.status ?? 1);
