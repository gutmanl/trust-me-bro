import { spawn, spawnSync } from "node:child_process";

import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from "../core/contracts";

/**
 * The one place that spawns child processes. Portability decisions live here:
 *
 * - Windows cannot spawn `.cmd` shims (npm-installed CLIs like `claude`)
 *   without a shell since the Node 18.20/20.12 security fix. Bare command
 *   names are therefore wrapped in `cmd.exe /d /s /c`; absolute `.exe` paths
 *   (e.g. Node itself in tests) spawn directly.
 * - `child.kill()` does not reliably reach grandchildren on Windows, so a
 *   timeout kills via `taskkill /T /F`; on POSIX the child starts detached in
 *   its own process group, which is killed as a whole.
 *
 * The runner never rejects: spawn failures resolve with a null exit code and
 * the error message on stderr, so backends map every outcome uniformly.
 */
export const nodeProcessRunner: ProcessRunner = { run: runChildProcess };

function runChildProcess(
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
  const isWindows = process.platform === "win32";
  const useCmdShim =
    isWindows && !options.command.toLowerCase().endsWith(".exe");
  const command = useCmdShim ? "cmd.exe" : options.command;
  const args = useCmdShim
    ? ["/d", "/s", "/c", options.command, ...options.args]
    : [...options.args];

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !isWindows,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        if (isWindows) {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      stderr += `${stderr === "" ? "" : "\n"}spawn failed: ${error.message}`;
      settle(null);
    });
    child.on("close", (code) => {
      settle(code);
    });

    if (options.input !== undefined) {
      child.stdin.on("error", () => {
        // A child that exits before reading stdin (or never reads it) breaks
        // the pipe; the close handler still reports the real outcome.
      });
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}
