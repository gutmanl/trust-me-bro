/**
 * Browser end-to-end configuration.
 *
 * Kept out of the vitest run on purpose: the specs are `tests/browser/*.spec.ts`,
 * and vitest collects `tests/**\/*.test.ts`, so `npm test` and
 * `npm run test:browser` never collide. They are separate CI jobs for the
 * same reason — a browser suite that gates the unit suite makes the fast
 * feedback loop as slow as the slow one.
 *
 * The server: `next dev` by default, because a production build in front of
 * every local run costs more than it catches for tests that are about wiring
 * rather than bundling. CI overrides it via `TMB_E2E_SERVER_CMD` to run the
 * built app, so the thing users install is what gets driven there.
 */
import os from "node:os";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { BROWSER_WORKSPACE } from "./tests/browser/workspace-path";

// Paths are relative to this config file. Playwright loads the config as
// CommonJS, so `import.meta.url` is unavailable here — hence the plain
// relative strings rather than a computed repo root.
const port = Number(process.env.TMB_E2E_PORT ?? 3123);

/**
 * Chromium executable, when the environment already provides one whose build
 * number does not match what this Playwright version would download.
 * Sandboxed CI images ship a pinned browser under `PLAYWRIGHT_BROWSERS_PATH`
 * and block the download; pointing at it directly is the supported escape
 * hatch. Unset elsewhere, so a normal `npx playwright install` wins.
 */
const executablePath = process.env.TMB_E2E_CHROMIUM;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./tests/browser/global-setup.ts",
  // The register serializes writes per project with a real file lock, and
  // several specs adjudicate the same project. Running them in parallel would
  // test the lock, not the UI.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    // localhost, not 127.0.0.1: Next 16's dev server rejects asset requests
    // whose origin is not in `allowedDevOrigins`, and the client chunks come
    // back 403 — the page server-renders, nothing hydrates, and every
    // interaction silently does nothing. Using the hostname the dev server
    // advertises avoids changing production config for a test.
    baseURL: `http://localhost:${port}`,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
    // The review workflow is meant to survive a narrow viewport; the
    // software review flagged mobile as untested.
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
  webServer: {
    command: process.env.TMB_E2E_SERVER_CMD ?? `npx next dev --port ${port}`,
    url: `http://localhost:${port}/projects`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Both are required, and the second is what keeps the first-run gate
      // out of the way: without a configured actor handle, `proxy.ts`
      // redirects every request to /setup.
      TMB_WORKSPACE: BROWSER_WORKSPACE,
      TMB_ACTOR_HANDLE: "lg",
      // Never read a developer's real installation config.
      TMB_CONFIG_PATH: path.join(os.tmpdir(), "tmb-browser-config.json"),
    },
  },
});
