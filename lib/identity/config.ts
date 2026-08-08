import path from "node:path";

import {
  defaultConfigFilePath,
  KUERZEL_PATTERN,
  readConfigFile,
} from "./config-file";
import { IdentityNotConfiguredError } from "./errors";
import type { AdapterConfig, IdentityConfig } from "./types";

const DEFAULT_WORKSPACE = "./workspace";

/**
 * Reads the identity configuration, layered per field (TMB-47):
 * env > stored config file > code default. The actor kuerzel has NO code
 * default — "who are you" must never be answered silently, so an
 * unconfigured state throws and the web layer's setup gate handles it.
 * The workspace root keeps its safe cwd-relative default. In the
 * single-user prototype these are constant answers from local
 * configuration; a later multi-user architecture would replace only this
 * module (Grobentwurf, extension seam 2).
 */
export function loadIdentityConfig(
  env: NodeJS.ProcessEnv = process.env,
): IdentityConfig {
  const stored = readConfigFile(defaultConfigFilePath(env));
  const kuerzel = env.TMB_ACTOR_KUERZEL ?? stored?.actorKuerzel;
  if (kuerzel === undefined) {
    throw new IdentityNotConfiguredError();
  }
  // Only the env value can be invalid here: the stored file is validated
  // against the same pattern on read (invalid file ⇒ unconfigured).
  if (!KUERZEL_PATTERN.test(kuerzel)) {
    throw new Error(
      `TMB_ACTOR_KUERZEL "${kuerzel}" is invalid: expected lowercase letters, digits, "_" or "-".`,
    );
  }
  return {
    actorKuerzel: kuerzel,
    workspaceRoot: path.resolve(
      env.TMB_WORKSPACE ?? stored?.workspaceRoot ?? DEFAULT_WORKSPACE,
    ),
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
