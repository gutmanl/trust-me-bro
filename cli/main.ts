import fs from "node:fs";
import path from "node:path";

import { runVerify } from "./verify";

/**
 * Argument handling of the `tmb` bin, separated from the process wiring in
 * tmb.ts so tests can drive it in-process. Messages are English like the
 * rest of the CLI's output: the report is code-facing evidence, unlike the
 * web UI's German display tier.
 */

const USAGE = [
  "usage: tmb verify <project-dir|bundle.tmb>",
  "",
  "Re-checks a TrustMeBro project directory or exported .tmb bundle",
  "independently of the application: field schema, hash chain, committed",
  "content state and blob integrity.",
  "",
  "exit codes: 0 everything holds, 1 verification failed, 2 usage error",
].join("\n");

export interface CliIo {
  out(message: string): void;
  err(message: string): void;
}

const consoleIo: CliIo = {
  out: (message) => console.log(message),
  err: (message) => console.error(message),
};

/**
 * The installed package's version, read from the nearest package.json named
 * "trustmebro" above `startDir` — the compiled bin lives at dist/cli/ inside
 * the package, the repo checkout runs from cli/, and the walk covers both.
 */
export function readCliVersion(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === "trustmebro" && parsed.version) {
          return parsed.version;
        }
      } catch {
        // unreadable candidate: keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** Directory of this module; undefined where CommonJS globals are absent. */
function ownDirectory(): string | undefined {
  try {
    return __dirname;
  } catch {
    return undefined;
  }
}

export function runCli(
  argv: string[],
  io: CliIo = consoleIo,
  versionStartDir?: string,
): number {
  const [command, ...args] = argv;

  if (command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-V" || command === "version") {
    const version = readCliVersion(
      versionStartDir ?? ownDirectory() ?? process.cwd(),
    );
    io.out(version ? `tmb (trustmebro) ${version}` : "tmb (trustmebro)");
    return 0;
  }
  if (command !== "verify" || args.length !== 1) {
    io.err(USAGE);
    return 2;
  }

  const report = runVerify(args[0]);
  for (const message of report.messages) {
    io.out(message);
  }
  return report.ok ? 0 : 1;
}
