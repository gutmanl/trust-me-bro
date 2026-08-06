import path from "node:path";

import type { AdapterConfig, IdentityConfig } from "./types";

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

const ADAPTER_DEFAULTS: AdapterConfig = {
  timeoutMs: 300_000,
  maxAttempts: 3,
  retryBaseDelayMs: 2_000,
  maxConcurrency: 2,
};

function positiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} "${raw}" is invalid: expected a positive integer.`,
    );
  }
  return value;
}

/**
 * Reads the adapter layer's runtime configuration (timeout, bounded retries,
 * CLI concurrency cap) from the environment, with code defaults. Lives here
 * because lib/identity is the single environment reader of the domain core.
 */
export function loadAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
): AdapterConfig {
  return {
    timeoutMs: positiveInt(
      "TMB_ADAPTER_TIMEOUT_MS",
      env.TMB_ADAPTER_TIMEOUT_MS,
      ADAPTER_DEFAULTS.timeoutMs,
    ),
    maxAttempts: positiveInt(
      "TMB_ADAPTER_MAX_ATTEMPTS",
      env.TMB_ADAPTER_MAX_ATTEMPTS,
      ADAPTER_DEFAULTS.maxAttempts,
    ),
    retryBaseDelayMs: positiveInt(
      "TMB_ADAPTER_RETRY_BASE_DELAY_MS",
      env.TMB_ADAPTER_RETRY_BASE_DELAY_MS,
      ADAPTER_DEFAULTS.retryBaseDelayMs,
    ),
    maxConcurrency: positiveInt(
      "TMB_ADAPTER_MAX_CONCURRENCY",
      env.TMB_ADAPTER_MAX_CONCURRENCY,
      ADAPTER_DEFAULTS.maxConcurrency,
    ),
  };
}
