#!/usr/bin/env node
/**
 * Standalone TrustMeBro CLI. Currently: `tmb verify <project-dir|bundle.tmb>`
 * — re-runs the hash-chain, manifest and blob-integrity verification without
 * the web application, for a project directory or a .tmb export bundle.
 * Installed packages expose it as the `tmb` bin; inside the repo it also runs
 * via `npm run tmb -- verify <target>`.
 */
import { runVerify } from "./verify";

function main(argv: string[]): number {
  const [command, ...args] = argv;
  if (command !== "verify" || args.length !== 1) {
    console.error("usage: tmb verify <project-dir|bundle.tmb>");
    return 2;
  }
  const report = runVerify(args[0]);
  for (const message of report.messages) {
    console.log(message);
  }
  return report.ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
