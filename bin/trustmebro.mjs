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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_NODE,
  clearInstanceLock,
  findFreePort,
  isNodeVersionSupported,
  openBrowser,
  parseStartPort,
  readInstanceLock,
  waitUntilReady,
  writeInstanceLock,
} from "./launcher-lib.mjs";

/**
 * Node version gate (D8), the first thing the module body does — every
 * import above it is a node: builtin or the side-effect-free launcher-lib, so
 * nothing can fail before this point.
 *
 * Deliberately a RUNTIME check and not `engine-strict` in .npmrc:
 * engine-strict only refuses an install, which does nothing for the person
 * who already installed the tarball and is now looking at an unexplained
 * crash from somewhere inside Next — and that is the case that matters.
 */
if (!isNodeVersionSupported(process.versions.node)) {
  console.error(
    `TrustMeBro benötigt Node.js ${REQUIRED_NODE.join(".")} oder neuer – ` +
      `gefunden wurde ${process.versions.node}.\n` +
      `Verwendete Node-Installation: ${process.execPath}\n` +
      "Bitte Node.js aktualisieren (https://nodejs.org) und den Aufruf " +
      "wiederholen.",
  );
  process.exit(1);
}

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const standaloneDir = path.join(packageRoot, ".next", "standalone");
const serverJs = path.join(standaloneDir, "server.js");

if (!fs.existsSync(serverJs)) {
  console.error(
    "TrustMeBro: In dieser Installation liegt kein Server.\n" +
      "Aus einem Repository-Checkout heraus zuerst das Paket bauen:\n" +
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

async function main() {
  const workspace = process.env.TMB_WORKSPACE;

  // One server per workspace. Starting a second one was silent — an occupied
  // port is skipped by design, so a double-clicked shortcut simply got the
  // next port — and the two processes then each believed they were the only
  // writer, because the run gate is an in-memory registry. Pointing the
  // browser at the instance that is already serving is both the safe answer
  // and the one the user wanted anyway.
  const running = readInstanceLock(workspace, fs);
  if (running) {
    const runningUrl = `http://127.0.0.1:${running.port}/`;
    console.log(
      `TrustMeBro läuft für dieses Arbeitsverzeichnis bereits ` +
        `(Prozess ${running.pid}, Port ${running.port}).\n` +
        `Es wird kein zweiter Server gestartet – ein zweiter würde ` +
        `dieselben Projekte bearbeiten und dabei doppelt Kontingent ` +
        `verbrauchen.\nGeöffnet wird stattdessen: ${runningUrl}`,
    );
    if (process.env.TMB_NO_BROWSER !== "1") {
      openBrowser(runningUrl);
    }
    return;
  }

  // Validated here rather than passed raw: an unusable TMB_PORT must name
  // itself instead of surfacing as a Node internals message.
  const startPort =
    process.env.TMB_PORT !== undefined
      ? parseStartPort(process.env.TMB_PORT, "TMB_PORT")
      : parseStartPort(process.env.PORT, "PORT");
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

  writeInstanceLock(workspace, port, fs);
  const releaseLock = () => clearInstanceLock(workspace, fs);
  process.on("exit", releaseLock);

  const forward = (signal) => {
    process.on(signal, () => {
      child.kill(signal);
    });
  };
  forward("SIGINT");
  forward("SIGTERM");
  child.on("exit", (code) => {
    releaseLock();
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
