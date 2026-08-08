#!/usr/bin/env node

/**
 * `npx trustmebro` launcher (TMB-48): starts the packaged standalone server,
 * waits until it answers, and opens the browser. Deliberately dependency-free
 * bootstrap OUTSIDE lib/ — identity/config questions stay in the app (the
 * proxy redirects a fresh installation to /setup); this script only picks a
 * port, sets safe defaults and wires the process.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const standaloneDir = path.join(packageRoot, ".next", "standalone");
const serverJs = path.join(standaloneDir, "server.js");

if (!fs.existsSync(serverJs)) {
  console.error(
    "TrustMeBro: no standalone server in this installation.\n" +
      "From a repository checkout, build the package first:\n" +
      "  npm run package:build && npm pack",
  );
  process.exit(1);
}

// Safe defaults, never overriding an explicit user choice: the workspace of
// a global npx install must not depend on the invocation directory.
if (process.env.TMB_WORKSPACE === undefined) {
  process.env.TMB_WORKSPACE = path.join(
    os.homedir(),
    ".trustmebro",
    "workspace",
  );
}

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const probe = (port, attemptsLeft) => {
      const server = net.createServer();
      server.once("error", () => {
        server.close();
        if (attemptsLeft === 0) {
          reject(new Error(`no free port found starting at ${start}`));
          return;
        }
        probe(port + 1, attemptsLeft - 1);
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, "127.0.0.1");
    };
    probe(start, 20);
  });
}

function waitUntilReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error("server did not become ready in time"));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

function openBrowser(url) {
  // `cmd /c start` treats the first quoted argument as the window TITLE —
  // the empty "" placeholder is load-bearing on Windows.
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      stdio: "ignore",
      detached: true,
    }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } else {
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

async function main() {
  const startPort = Number(process.env.TMB_PORT ?? process.env.PORT ?? 4173);
  const port = await findFreePort(startPort);
  const url = `http://127.0.0.1:${port}/`;

  const child = spawn(process.execPath, [serverJs], {
    cwd: standaloneDir,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(port),
      // Single-user tool: bind loopback only, never LAN-exposed (Next's own
      // default would be 0.0.0.0).
      HOSTNAME: "127.0.0.1",
    },
  });

  const forward = (signal) => {
    process.on(signal, () => {
      child.kill(signal);
    });
  };
  forward("SIGINT");
  forward("SIGTERM");
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  try {
    await waitUntilReady(url, 60_000);
  } catch (error) {
    console.error(`TrustMeBro: ${error.message}`);
    child.kill("SIGTERM");
    process.exit(1);
  }

  console.log(`TrustMeBro läuft: ${url}`);
  console.log(`Workspace: ${process.env.TMB_WORKSPACE}`);
  if (process.env.TMB_NO_BROWSER !== "1") {
    openBrowser(url);
  }
}

main().catch((error) => {
  console.error(
    `TrustMeBro: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
});
