#!/usr/bin/env node
/**
 * Standalone TrustMeBro CLI. Currently: `tmb verify <project-dir|bundle.tmb>`
 * — re-runs the hash-chain, manifest and blob-integrity verification without
 * the web application, for a project directory or a .tmb export bundle.
 * Installed packages expose it as the `tmb` bin; inside the repo it also runs
 * via `npm run tmb -- verify <target>`. All argument handling lives in
 * main.ts so tests can drive it in-process.
 */
import { runCli } from "./main";

process.exitCode = runCli(process.argv.slice(2));
