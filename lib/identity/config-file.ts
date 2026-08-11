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
  actorHandle: string;
  workspaceRoot?: string;
  /** Unpaywall contact address (reference auto-import, Task 3b/Amendment
   * 2) — installation-level like the handle, so it lives in the same file.
   * Absent means "not configured via the file" (env may still supply it;
   * see config.ts's getUnpaywallSetting for the merged precedence). */
  unpaywallEmail?: string;
}

/**
 * Handle becomes part of actor ids ("human:<handle>") that are hashed into
 * the register's chain entries, so it is restricted to a stable ASCII subset.
 * Single source of the rule — config.ts and the setup use-case both consume
 * this predicate.
 */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidActorHandle(value: string): boolean {
  return HANDLE_PATTERN.test(value);
}

/**
 * Current on-disk config generation. Every write stamps it; every read runs
 * the file through the migration ladder up to it before validating.
 */
export const CONFIG_VERSION = 1;

/**
 * Snake_case on disk, matching the register's file conventions. A plain
 * `z.object` (unknown keys stripped, not rejected) rather than a strict one:
 * a file written by a newer version carrying a field this build does not know
 * must not collapse the whole config to "unconfigured" and strand the user
 * back at first-run setup — the known fields (who the actor is, where the
 * workspace lives) still parse. Forward-compatibility is the point of the
 * version field.
 */
const ConfigFileSchema = z.object({
  config_version: z.number().int().positive().optional(),
  actor_handle: z.string().regex(HANDLE_PATTERN),
  workspace_root: z.string().min(1).optional(),
  unpaywall_email: z.string().min(1).optional(),
});

/**
 * Migrates a stored config to the current shape before validation, so every
 * reader only ever sees CONFIG_VERSION. The migration seam: a future version
 * bump adds a step here, keyed off `config_version` (absent means v1 — the
 * pre-versioning files ARE the first version and need no migration). Today v1
 * is the only version, so this only guards against a non-object payload;
 * forward-compatible unknown keys are handled by the non-strict schema, not
 * here.
 */
function migrateConfigFile(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) {
    return parsed; // let the schema reject non-objects
  }
  return parsed;
}

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
  const result = ConfigFileSchema.safeParse(migrateConfigFile(parsed));
  if (!result.success) {
    return undefined;
  }
  return {
    actorHandle: result.data.actor_handle,
    workspaceRoot: result.data.workspace_root,
    unpaywallEmail: result.data.unpaywall_email,
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
  if (!isValidActorHandle(config.actorHandle)) {
    throw new Error(
      `Actor handle "${config.actorHandle}" is invalid: expected lowercase letters, digits, "_" or "-".`,
    );
  }
  const payload = `${JSON.stringify(
    {
      config_version: CONFIG_VERSION,
      actor_handle: config.actorHandle,
      ...(config.workspaceRoot !== undefined
        ? { workspace_root: config.workspaceRoot }
        : {}),
      ...(config.unpaywallEmail !== undefined
        ? { unpaywall_email: config.unpaywallEmail }
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
