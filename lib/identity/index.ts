import path from "node:path";

import { loadIdentityConfig } from "./config";
import type { HumanActorId } from "./types";

export type {
  ActorId,
  AdapterConfig,
  HumanActorId,
  SystemActorId,
  IdentityConfig,
} from "./types";
export { loadAdapterConfig, loadIdentityConfig } from "./config";

/**
 * Project directory names double as path segments below the workspace root,
 * so they are restricted to a safe ASCII subset (no separators, no dot
 * prefixes — rules out traversal by construction).
 */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** The acting local user as recorded in history entries. */
export function getCurrentActor(): HumanActorId {
  return `human:${loadIdentityConfig().actorKuerzel}`;
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
