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
} from "./types";
export {
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
 * winning even directly after setup).
 */
export function writeIdentityConfig(input: {
  actorHandle: string;
  workspaceRoot?: string;
}): IdentityConfig {
  writeConfigFile(defaultConfigFilePath(), {
    actorHandle: input.actorHandle,
    workspaceRoot: input.workspaceRoot,
  });
  return loadIdentityConfig();
}
