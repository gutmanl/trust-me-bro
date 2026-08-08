import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

/**
 * Stored first-run configuration (TMB-47): the browser-based setup page
 * writes this file once; afterwards it answers "who is the actor" (and
 * optionally "where is the workspace") whenever the environment does not.
 * Precedence stays env > stored file > code default, so the test suite's
 * env injection keeps working unchanged.
 *
 * The file lives OUTSIDE the workspace (default ~/.trustmebro/config.json,
 * override via TMB_CONFIG_PATH) because the workspace location is itself
 * one of the answers the file may provide.
 */
export interface IdentityConfigFile {
  actorKuerzel: string;
  workspaceRoot?: string;
}

/**
 * Kuerzel becomes part of actor ids ("human:<kuerzel>") that are hashed into
 * the register's chain entries, so it is restricted to a stable ASCII subset.
 * Single source of the rule — config.ts and the setup use-case both consume
 * this predicate.
 */
export const KUERZEL_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidActorKuerzel(value: string): boolean {
  return KUERZEL_PATTERN.test(value);
}

/** Snake_case on disk, matching the register's file conventions. */
const ConfigFileSchema = z.strictObject({
  actor_kuerzel: z.string().regex(KUERZEL_PATTERN),
  workspace_root: z.string().min(1).optional(),
});

export function defaultConfigFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.TMB_CONFIG_PATH ?? path.join(os.homedir(), ".trustmebro", "config.json")
  );
}

/**
 * Reads the stored configuration. Never throws: a missing, unparsable or
 * shape-invalid file degrades to "unconfigured" (the setup gate re-engages)
 * instead of crashing the server at every request.
 */
export function readConfigFile(
  filePath: string,
): IdentityConfigFile | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    return undefined;
  }
  return {
    actorKuerzel: result.data.actor_kuerzel,
    workspaceRoot: result.data.workspace_root,
  };
}

/**
 * Writes the stored configuration atomically (temp file + rename). This is
 * lib/identity's ONE sanctioned raw-write site, allowlisted by the
 * architecture guard: the register's atomic-write helper cannot be reused
 * here because lib/register depends on lib/identity — the import would run
 * against the layering, so the ~5 lines are deliberately duplicated.
 */
export function writeConfigFile(
  filePath: string,
  config: IdentityConfigFile,
): void {
  if (!isValidActorKuerzel(config.actorKuerzel)) {
    throw new Error(
      `Actor kuerzel "${config.actorKuerzel}" is invalid: expected lowercase letters, digits, "_" or "-".`,
    );
  }
  const payload = `${JSON.stringify(
    {
      actor_kuerzel: config.actorKuerzel,
      ...(config.workspaceRoot !== undefined
        ? { workspace_root: config.workspaceRoot }
        : {}),
    },
    null,
    2,
  )}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, payload, "utf8");
  fs.renameSync(tempPath, filePath);
}
