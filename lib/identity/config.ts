import path from "node:path";

import type { IdentityConfig } from "./types";

const DEFAULT_WORKSPACE = "./workspace";
const DEFAULT_KUERZEL = "user";

/**
 * Kuerzel becomes part of actor ids ("human:<kuerzel>") that are hashed into
 * the register's chain entries, so it is restricted to a stable ASCII subset.
 */
const KUERZEL_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Reads the identity configuration from the environment. In the single-user
 * prototype these are constant answers from local configuration; a later
 * multi-user architecture would replace only this module (Grobentwurf,
 * extension seam 2).
 */
export function loadIdentityConfig(
  env: NodeJS.ProcessEnv = process.env,
): IdentityConfig {
  const kuerzel = env.TMB_ACTOR_KUERZEL ?? DEFAULT_KUERZEL;
  if (!KUERZEL_PATTERN.test(kuerzel)) {
    throw new Error(
      `TMB_ACTOR_KUERZEL "${kuerzel}" is invalid: expected lowercase letters, digits, "_" or "-".`,
    );
  }
  return {
    actorKuerzel: kuerzel,
    workspaceRoot: path.resolve(env.TMB_WORKSPACE ?? DEFAULT_WORKSPACE),
  };
}
