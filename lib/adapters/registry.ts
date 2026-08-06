import type { ProjectConfig } from "../register";
import { createClaudeBackend } from "./backends/claude/claude-backend";
import { createCodexBackend } from "./backends/codex/codex-backend";
import type { Backend, ProcessRunner } from "./core/contracts";
import { UnknownBackendError } from "./core/errors";

export interface RegistryOptions {
  readonly processRunner?: ProcessRunner;
}

export interface ConfiguredBackends {
  readonly primary: Backend;
  /** Absent when the project runs with the divergence rule disabled. */
  readonly secondary?: Backend;
}

type BackendRefValue = ProjectConfig["backends"]["primary"];

function createBackendForRef(
  ref: BackendRefValue,
  options: RegistryOptions,
): Backend {
  switch (ref.cli) {
    case "claude":
      return createClaudeBackend(options);
    case "codex":
      return createCodexBackend(options);
    default:
      throw new UnknownBackendError(ref.cli);
  }
}

/**
 * Resolves the `backends.primary`/`backends.secondary` entries of the
 * project's claims.json config to concrete adapters — the only place that
 * maps the configured `cli` string to an implementation (A7: judgments are
 * interchangeable between backends without pipeline changes).
 */
export function resolveConfiguredBackends(
  config: ProjectConfig,
  options: RegistryOptions = {},
): ConfiguredBackends {
  return {
    primary: createBackendForRef(config.backends.primary, options),
    secondary:
      config.backends.secondary === undefined
        ? undefined
        : createBackendForRef(config.backends.secondary, options),
  };
}
