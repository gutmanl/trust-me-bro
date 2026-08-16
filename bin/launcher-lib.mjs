/**
 * Testable helpers for the `trustmebro` launcher (bin/trustmebro.mjs). Kept in
 * a side-effect-free module so the port/version/readiness logic — all
 * release-critical and cross-platform-sensitive — can be exercised by tests
 * without the bin's module-level process wiring running on import.
 */

import http from "node:http";
import net from "node:net";
import pathModule from "node:path";
import { spawn } from "node:child_process";

/** Minimum supported Node.js, as [major, minor]. */
export const REQUIRED_NODE = [20, 9];

/** Start port when neither TMB_PORT nor PORT is set. */
export const DEFAULT_START_PORT = 4173;

/**
 * Parses a TMB_PORT/PORT value into a usable start port. Unset or blank
 * falls back to the default; anything that is not a whole port number is
 * rejected with a message that names the variable — the raw Node error
 * ("options.port should be >= 0 and < 65536") never mentions it and left
 * a misconfigured .env unexplained.
 */
export function parseStartPort(raw, variableName = "TMB_PORT") {
  if (raw === undefined || String(raw).trim() === "") {
    return DEFAULT_START_PORT;
  }
  const port = Number(String(raw).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${variableName}="${raw}" ist ungültig: erwartet wird eine ganze ` +
        "Portnummer zwischen 1 und 65535.",
    );
  }
  return port;
}

/** Whether a `process.versions.node`-style string meets the minimum. */
export function isNodeVersionSupported(
  versionString,
  required = REQUIRED_NODE,
) {
  const [major, minor] = String(versionString).split(".").map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return false; // unparseable: fail closed, the gate refuses to run
  }
  return major > required[0] || (major === required[0] && minor >= required[1]);
}

/**
 * The first free loopback port at or after `start`, probing up to
 * `maxAttempts` consecutive ports. Rejects if none is free.
 */
export function findFreePort(start, maxAttempts = 20) {
  return new Promise((resolve, reject) => {
    const probe = (port, attemptsLeft) => {
      if (!Number.isInteger(port) || port < 1) {
        reject(new Error(`Startport ${String(start)} ist ungültig.`));
        return;
      }
      if (port > 65535) {
        // The walk from an occupied high port must not run off the end of
        // the port range into a raw Node range error.
        reject(
          new Error(
            `Kein freier Port ab ${start} gefunden (Portbereich endet bei 65535).`,
          ),
        );
        return;
      }
      const server = net.createServer();
      server.once("error", () => {
        server.close();
        if (attemptsLeft === 0) {
          reject(new Error(`Kein freier Port ab ${start} gefunden.`));
          return;
        }
        probe(port + 1, attemptsLeft - 1);
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, "127.0.0.1");
    };
    probe(start, maxAttempts);
  });
}

/** Polls `url` until it answers or `timeoutMs` elapses. */
export function waitUntilReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error("Der Server war nicht rechtzeitig erreichbar."));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

/** Opens the OS browser at `url`. `platform` is injectable for testing. */
export function openBrowser(url, platform = process.platform) {
  // `cmd /c start` treats the first quoted argument as the window TITLE —
  // the empty "" placeholder is load-bearing on Windows.
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      stdio: "ignore",
      detached: true,
    }).unref();
  } else if (platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } else {
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

/**
 * Name of the lock file the launcher keeps in the workspace root, recording
 * which process is already serving it.
 */
export const INSTANCE_LOCK_FILE = ".trustmebro-instance.json";

/** True when a process with this pid exists and we may signal it. */
function processIsAlive(pid) {
  try {
    // Signal 0 performs the permission/existence check without delivering
    // anything — the standard liveness probe.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else: still alive.
    return error?.code === "EPERM";
  }
}

/**
 * Reads the instance lock of a workspace, or null when there is none, it is
 * unreadable/corrupt, or the process it names is gone.
 *
 * Why this exists: the run gate the interface promises ("Pro Projekt kann
 * nur ein Lauf gleichzeitig laufen") is enforced by an in-memory registry,
 * which makes it a per-PROCESS guarantee. The launcher, meanwhile, skips an
 * occupied port and cheerfully starts a SECOND server on the next one — so
 * double-clicking the shortcut, or retrying a start that felt slow, gave two
 * servers on one workspace, each believing it was the only writer. The
 * register survives that (its writes are atomically renamed under a
 * cross-process file lock, proven in tests/e2e/multiprocess.e2e.test.ts);
 * what does not survive is the promise, and the user pays for the breakage
 * in doubled agent-CLI quota with no indication anything is wrong.
 *
 * A stale lock is not an error: a machine that lost power mid-run leaves one
 * behind, and refusing to start until it is deleted by hand would be a worse
 * failure than the one being prevented.
 */
export function readInstanceLock(workspace, fs) {
  let raw;
  try {
    raw = fs.readFileSync(
      pathModule.join(workspace, INSTANCE_LOCK_FILE),
      "utf8",
    );
  } catch {
    return null;
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Number.isInteger(lock?.pid) || !Number.isInteger(lock?.port)) {
    return null;
  }
  if (lock.pid === process.pid || !processIsAlive(lock.pid)) {
    return null;
  }
  return lock;
}

/** Writes this process's instance lock into the workspace. */
export function writeInstanceLock(workspace, port, fs) {
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    pathModule.join(workspace, INSTANCE_LOCK_FILE),
    `${JSON.stringify({ pid: process.pid, port, started_at: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

/** Removes this process's instance lock; never throws. */
export function clearInstanceLock(workspace, fs) {
  try {
    const file = pathModule.join(workspace, INSTANCE_LOCK_FILE);
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    // Only ever remove our own: a lock rewritten by a newer instance must
    // outlive this one's shutdown.
    if (lock?.pid === process.pid) {
      fs.rmSync(file, { force: true });
    }
  } catch {
    // Nothing to clear, or someone else's — either way, not our business.
  }
}
