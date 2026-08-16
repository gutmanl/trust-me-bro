import path from "node:path";

import {
  defaultConfigFilePath,
  expandTilde,
  HANDLE_PATTERN,
  readConfigFile,
} from "./config-file";
import { IdentityNotConfiguredError } from "./errors";
import type {
  AdapterConfig,
  FeatureFlags,
  IdentityConfig,
  UnpaywallSetting,
} from "./types";

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
  // Blank env values count as unset (an emptied line in .env), and
  // surrounding whitespace is stripped — matching getActorHandleSetting, so
  // the settings page and the actual writes can never disagree.
  const envHandle = env.TMB_ACTOR_HANDLE?.trim();
  const handle = envHandle || stored?.actorHandle;
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
      expandTilde(
        env.TMB_WORKSPACE?.trim() || stored?.workspaceRoot || DEFAULT_WORKSPACE,
      ),
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

/**
 * The Unpaywall setting (reference auto-import, Task 3b/Amendment 2), with
 * its source discriminator so the UI can tell an env-provided address
 * (read-only there) from a stored, user-editable one. Precedence mirrors
 * the actor handle: env > stored config file > "unset" — there is no code
 * default, absence is a fully graceful state (the document-url derivation
 * just skips the Unpaywall step, never an error).
 */
export function getUnpaywallSetting(
  env: NodeJS.ProcessEnv = process.env,
): UnpaywallSetting {
  const fromEnv = env.TMB_UNPAYWALL_EMAIL?.trim();
  if (fromEnv) {
    return { email: fromEnv, source: "env" };
  }
  const fromFile = readConfigFile(defaultConfigFilePath(env))?.unpaywallEmail;
  if (fromFile) {
    return { email: fromFile, source: "config" };
  }
  return { email: null, source: "unset" };
}

/**
 * The effective actor handle with its source discriminator (TMB-54, D6).
 * The handle became editable at installation level, and the settings page
 * has to distinguish an env-provided handle (not editable there) from a
 * stored one. Unlike loadIdentityConfig this never throws: an unconfigured
 * installation reports source "unset", which the caller renders as a
 * pointer back to the wizard.
 */
export function getActorHandleSetting(env: NodeJS.ProcessEnv = process.env): {
  handle: string | null;
  source: "env" | "config" | "unset";
} {
  const fromEnv = env.TMB_ACTOR_HANDLE?.trim();
  if (fromEnv) {
    return { handle: fromEnv, source: "env" };
  }
  const fromFile = readConfigFile(defaultConfigFilePath(env))?.actorHandle;
  if (fromFile) {
    return { handle: fromFile, source: "config" };
  }
  return { handle: null, source: "unset" };
}

/**
 * The workspace root with its source discriminator (TMB-54), mirroring
 * getUnpaywallSetting(): the first-run wizard offers to change it, but an
 * env-provided root is not editable from the UI, and the code default has
 * to be distinguishable from a deliberately stored choice.
 */
export function getWorkspaceRootSetting(env: NodeJS.ProcessEnv = process.env): {
  root: string;
  source: "env" | "config" | "default";
} {
  const fromEnv = env.TMB_WORKSPACE?.trim();
  if (fromEnv) {
    return { root: path.resolve(expandTilde(fromEnv)), source: "env" };
  }
  const fromFile = readConfigFile(defaultConfigFilePath(env))?.workspaceRoot;
  if (fromFile) {
    return { root: path.resolve(expandTilde(fromFile)), source: "config" };
  }
  return { root: path.resolve(DEFAULT_WORKSPACE), source: "default" };
}

/** Convenience accessor over getUnpaywallSetting() for call sites that only
 * need the address, not its provenance — the document-url derivation
 * (reference-scan/derive-document-url.ts). */
export function getUnpaywallEmail(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return getUnpaywallSetting(env).email;
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
