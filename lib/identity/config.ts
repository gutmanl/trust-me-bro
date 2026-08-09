import path from "node:path";

import {
  defaultConfigFilePath,
  HANDLE_PATTERN,
  readConfigFile,
} from "./config-file";
import { IdentityNotConfiguredError } from "./errors";
import type { AdapterConfig, FeatureFlags, IdentityConfig } from "./types";

const DEFAULT_WORKSPACE = "./workspace";

/**
 * Reads the identity configuration, layered per field (TMB-47):
 * env > stored config file > code default. The actor handle has NO code
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
  const handle = env.TMB_ACTOR_HANDLE ?? stored?.actorHandle;
  if (handle === undefined) {
    throw new IdentityNotConfiguredError();
  }
  // Only the env value can be invalid here: the stored file is validated
  // against the same pattern on read (invalid file ⇒ unconfigured).
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error(
      `TMB_ACTOR_HANDLE "${handle}" is invalid: expected lowercase letters, digits, "_" or "-".`,
    );
  }
  return {
    actorHandle: handle,
    workspaceRoot: path.resolve(
      env.TMB_WORKSPACE ?? stored?.workspaceRoot ?? DEFAULT_WORKSPACE,
    ),
  };
}

/**
 * Feature flags (TMB-51). Lives here because lib/identity is the single
 * environment reader of the domain core.
 */
export function loadFeatureFlags(
  env: NodeJS.ProcessEnv = process.env,
): FeatureFlags {
  return { apiBackendEnabled: env.TMB_ENABLE_API_BACKEND === "1" };
}

/**
 * The Anthropic API key for the TMB-51 spike backend. Kept separate from the
 * boolean flag so "flag off" and "key missing" stay independently
 * diagnosable; both must be present for the adapter to be constructible.
 */
export function loadAnthropicApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = env.ANTHROPIC_API_KEY;
  return key === undefined || key === "" ? undefined : key;
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
