/**
 * The one workspace path the browser suite uses.
 *
 * It is a fixed location rather than an `mkdtemp` one because
 * `webServer.env` in `playwright.config.ts` is resolved when the config
 * loads — before global setup runs — so the server has to be told where the
 * workspace will be before it exists. Global setup then clears and seeds
 * exactly this directory, which also makes a re-run independent of whatever
 * a previous run left behind.
 */
import os from "node:os";
import path from "node:path";

export const BROWSER_WORKSPACE = path.join(
  os.tmpdir(),
  "tmb-browser-workspace",
);
