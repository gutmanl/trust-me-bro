/**
 * Removes every trace of a previous run, so the suite starts from the state
 * a freshly installed copy is in: no configuration file, no workspace.
 */
import fs from "node:fs";

import { COLD_HOME } from "./paths";

export default function globalSetup(): void {
  fs.rmSync(COLD_HOME, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(COLD_HOME, { recursive: true });
  console.log(`[cold-start] cleared ${COLD_HOME}`);
}
