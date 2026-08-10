import path from "node:path";

import { loadIdentityConfig } from "./config";
import {
  defaultConfigFilePath,
  readConfigFile,
  writeConfigFile,
} from "./config-file";
import type { HumanActorId, IdentityConfig } from "./types";

export type {
  ActorId,
  AdapterConfig,
  FeatureFlags,
  HumanActorId,
  SystemActorId,
  IdentityConfig,
  UnpaywallSetting,
} from "./types";
export {
  getUnpaywallEmail,
  getUnpaywallSetting,
  loadAdapterConfig,
  loadAnthropicApiKey,
  loadFeatureFlags,
  loadIdentityConfig,
} from "./config";
export { isValidActorHandle } from "./config-file";
export { IdentityNotConfiguredError } from "./errors";

/**
 * Project directory names double as path segments below the workspace root,
 * so they are restricted to a safe ASCII subset (no separators, no dot
 * prefixes — rules out traversal by construction).
 */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** The acting local user as recorded in history entries. */
export function getCurrentActor(): HumanActorId {
  return `human:${loadIdentityConfig().actorHandle}`;
}

/** Absolute path of the workspace root (created lazily by the persistence layer). */
export function getWorkspaceRoot(): string {
  return loadIdentityConfig().workspaceRoot;
}

/**
 * Absolute path of a project directory. The sole path-construction authority:
 * all project access goes through the workspace abstraction instead of freely
 * constructed paths (Grobentwurf, extension seam 3).
 */
export function resolveProjectDir(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(
      `Project id "${projectId}" is invalid: expected lowercase letters, digits, ".", "_" or "-", not starting with "." .`,
    );
  }
  return path.join(getWorkspaceRoot(), projectId);
}

/**
 * Whether an actor handle is available from ANY source (env or stored
 * file) — the cheap, never-throwing predicate the first-run gate (proxy.ts)
 * consults on every request (TMB-47).
 */
export function isIdentityConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.TMB_ACTOR_HANDLE !== undefined ||
    readConfigFile(defaultConfigFilePath(env)) !== undefined
  );
}

/**
 * Persists the first-run configuration and returns the now-effective
 * identity (re-read through the regular layering, so an env override keeps
 * winning even directly after setup). Reads the current file first and
 * carries every field the caller did not explicitly supply — most notably
 * `unpaywallEmail` (C1 fix): setup's Unpaywall step can run either side of
 * this call, and a previously-stored address must survive either order
 * instead of being silently dropped by a write that only ever knew about
 * `actorHandle`/`workspaceRoot`.
 */
export function writeIdentityConfig(input: {
  actorHandle: string;
  workspaceRoot?: string;
}): IdentityConfig {
  const filePath = defaultConfigFilePath();
  const existing = readConfigFile(filePath);
  writeConfigFile(filePath, {
    actorHandle: input.actorHandle,
    workspaceRoot: input.workspaceRoot ?? existing?.workspaceRoot,
    unpaywallEmail: existing?.unpaywallEmail,
  });
  return loadIdentityConfig();
}

/**
 * Persists (or, with `email === null`, clears) the stored Unpaywall address
 * (reference auto-import, Task 3b/Amendment 2) while preserving every other
 * field of the config file — reads the current file first so an existing
 * workspace root is never dropped by an unrelated write. When no file
 * exists yet (actor handle configured via TMB_ACTOR_HANDLE alone), the
 * currently effective handle is carried into the newly created file so it
 * stays schema-valid (actor_handle is mandatory on disk).
 */
export function writeUnpaywallEmail(email: string | null): void {
  const filePath = defaultConfigFilePath();
  const existing = readConfigFile(filePath);
  const actorHandle = existing?.actorHandle ?? loadIdentityConfig().actorHandle;
  writeConfigFile(filePath, {
    actorHandle,
    workspaceRoot: existing?.workspaceRoot,
    unpaywallEmail: email ?? undefined,
  });
}
