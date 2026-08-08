/**
 * Standalone TrustMeBro CLI. Currently: `tmb verify <project-dir|bundle.tmb>`
 * — re-runs the hash-chain, manifest and blob-integrity verification without
 * the web application, for a project directory or a .tmb export bundle.
 * Run via `npm run tmb -- verify <target>` (packaging as a bin is part of
 * the installation epic).
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
