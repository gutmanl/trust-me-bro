/**
 * Browser suite for first contact: a genuinely unconfigured installation.
 *
 * A separate config rather than another project in `playwright.config.ts`,
 * because the difference between the two suites is the SERVER's environment
 * — no actor handle, an empty workspace, a config file that does not exist —
 * and a webServer is started once per config, not once per project. It also
 * keeps the two from sharing a port or a workspace, which is what makes each
 * one's assertions independent of whether the other ran.
 *
 * Desktop only: what this suite tests is the first-run gate, the wizard's
 * server actions and the diagnosis copy. Layout at narrow widths is the
 * seeded suite's concern, and running the wizard twice would double the
 * slowest part of the job for no new signal.
 */
import fs from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import {
  COLD_CWD,
  COLD_HOME,
  COLD_PATH_DIR,
} from "./tests/browser/cold-start/paths";

/**
 * Built here rather than in global setup, because Playwright starts the web
 * server BEFORE global setup runs — a PATH assembled there would not exist
 * yet when the server needs it.
 *
 * Node itself stays reachable: Turbopack spawns a pooled worker for PostCSS
 * and resolves it through PATH, so an entirely empty one takes the dev
 * server down before the first page compiles. Linking just that binary keeps
 * the agent CLIs — the actual subject — undiscoverable.
 */
fs.mkdirSync(COLD_PATH_DIR, { recursive: true });
const nodeLink = path.join(COLD_PATH_DIR, "node");
if (!fs.existsSync(nodeLink)) {
  fs.symlinkSync(process.execPath, nodeLink);
}

// Recreated empty on every load, BEFORE the server starts: the server runs
// with this as its cwd so the cwd-relative workspace default resolves to a
// directory with zero projects — see COLD_CWD in paths.ts for the failure
// mode (a developer's real workspace) this exists to make unreachable.
fs.rmSync(COLD_CWD, { recursive: true, force: true, maxRetries: 5 });
fs.mkdirSync(COLD_CWD, { recursive: true });

const port = Number(process.env.TMB_E2E_COLD_PORT ?? 3124);
const executablePath = process.env.TMB_E2E_CHROMIUM;

export default defineConfig({
  testDir: "./tests/browser/cold-start",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./tests/browser/cold-start/global-setup.ts",
  // The wizard is a sequence: step 2 is only reachable once step 1 was
  // submitted. Serial execution in one worker is not a concession here, it
  // is the subject.
  workers: 1,
  fullyParallel: false,
  // Above Playwright's 5 s default because this suite's server is COLD by
  // design: every route a spec reaches is compiled by the dev server on
  // first contact, and a first compile of the project workbench measured
  // 4.8 s on a loaded machine — the assertion after it then times out with
  // the navigation mid-flight. Latency is not this suite's subject.
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    // localhost, not 127.0.0.1: Next 16's dev server refuses asset requests
    // from an origin outside `allowedDevOrigins`, and the page then renders
    // without ever hydrating.
    baseURL: `http://localhost:${port}`,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Node by absolute path, so the server still starts under the empty
    // PATH below (see COLD_PATH_DIR for why the PATH is empty). Everything
    // else absolute too, and the app directory passed as an argument: cwd
    // below is the COLD_CWD scratch directory, not the repository, so no
    // relative path would resolve — and `next dev` does not chdir into its
    // directory argument, which is exactly what keeps the cwd-relative
    // workspace default pointed at scratch instead of at the repo.
    command:
      process.env.TMB_E2E_SERVER_CMD ??
      `${process.execPath} ${path.join(__dirname, "node_modules/next/dist/bin/next")} dev ${__dirname} --port ${port}`,
    cwd: COLD_CWD,
    // The gate redirects everything, so readiness is checked on /setup —
    // /projects would answer 307 and look like a failure to start.
    url: `http://localhost:${port}/setup`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // A stand-in home directory, and nothing else — so the application
      // resolves its own documented defaults (~/.trustmebro/config.json, the
      // workspace beside it) exactly as it would on a fresh machine.
      HOME: COLD_HOME,
      USERPROFILE: COLD_HOME,
      // Explicitly blank rather than absent: Playwright merges webServer env
      // over the parent process's, so a developer with any of these set in
      // their shell would otherwise start the server already configured — or
      // pointed at their real workspace — and skip the subject of this suite.
      // Blank counts as unset throughout the identity layer.
      TMB_ACTOR_HANDLE: "",
      TMB_WORKSPACE: "",
      TMB_CONFIG_PATH: "",
      // No agent CLI is discoverable, whoever runs this.
      PATH: COLD_PATH_DIR,
    },
  },
});
