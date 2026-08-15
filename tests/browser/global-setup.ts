/** Playwright global setup: rebuilds the seeded workspace before any spec runs. */
import { seedBrowserWorkspace } from "./seed-workspace";

export default async function globalSetup(): Promise<void> {
  const workspace = await seedBrowserWorkspace();
  console.log(`[browser] seeded workspace: ${workspace}`);
}
