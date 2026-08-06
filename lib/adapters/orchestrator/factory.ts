import { loadAdapterConfig } from "../../identity";
import type { ProjectConfig } from "../../register";
import type { ProcessRunner } from "../core/contracts";
import { resolveConfiguredBackends } from "../registry";
import { getGlobalConcurrencyGate } from "../runtime/concurrency-gate";
import { fileTraceSink } from "../runtime/trace-sink";
import { Orchestrator } from "./orchestrator";

export interface ProjectOrchestratorOptions {
  /** Test seam; production uses the real child-process runner. */
  readonly processRunner?: ProcessRunner;
}

/**
 * Production wiring in one place: backends from the project's claims.json
 * config, the file trace sink, the process-global concurrency gate, and the
 * retry policy from the environment-backed adapter config. The pipeline
 * epic calls this factory and never assembles the parts by hand.
 */
export function createProjectOrchestrator(
  config: ProjectConfig,
  options: ProjectOrchestratorOptions = {},
): Orchestrator {
  const { primary, secondary } = resolveConfiguredBackends(config, options);
  const adapterConfig = loadAdapterConfig();
  return new Orchestrator({
    backends: secondary === undefined ? [primary] : [primary, secondary],
    traceSink: fileTraceSink,
    gate: getGlobalConcurrencyGate(),
    policy: {
      maxAttempts: adapterConfig.maxAttempts,
      retryBaseDelayMs: adapterConfig.retryBaseDelayMs,
    },
  });
}
