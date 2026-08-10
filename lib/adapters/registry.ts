import { loadAnthropicApiKey, loadFeatureFlags } from "../identity";
import type { ProjectConfig } from "../register";
import { createAnthropicApiBackend } from "./backends/anthropic-api/anthropic-api-backend";
import { createClaudeBackend } from "./backends/claude/claude-backend";
import { createCodexBackend } from "./backends/codex/codex-backend";
import { createMockBackend } from "./backends/mock/mock-backend";
import type { Backend, HttpPort, ProcessRunner } from "./core/contracts";
import { UnknownBackendError } from "./core/errors";

export interface RegistryOptions {
  readonly processRunner?: ProcessRunner;
  /** Test seam of the TMB-51 API spike backend. */
  readonly httpPort?: HttpPort;
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
    case "mock":
      // Demonstration backend: canned, schema-valid outputs for every job
      // kind, no process and no account. Ungated on purpose — it exists so
      // the application is usable without a paid CLI, which a feature flag
      // would defeat. Its provenance is carried by the actor
      // `system:demo_seed` in the chained history instead.
      // It spawns no process and opens no socket, so neither registry seam
      // applies to it.
      return createMockBackend();
    case "anthropic-api": {
      // TMB-51 spike, double-gated: the feature flag AND the key must both
      // be present — otherwise the id degrades exactly like an unknown CLI,
      // so the prototype runs unchanged without an API key.
      const apiKey = loadAnthropicApiKey();
      if (!loadFeatureFlags().apiBackendEnabled || apiKey === undefined) {
        throw new UnknownBackendError(ref.cli);
      }
      return createAnthropicApiBackend({
        apiKey,
        ...(options.httpPort ? { httpPort: options.httpPort } : {}),
      });
    }
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
