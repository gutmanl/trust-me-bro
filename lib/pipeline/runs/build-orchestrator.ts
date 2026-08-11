import { createProjectOrchestrator, UnknownBackendError } from "../../adapters";
import type { Orchestrator } from "../../adapters";
import type { ProjectConfig } from "../../register";
import { BackendUnavailableError } from "../errors";

/**
 * Builds the orchestrator for a run, translating the one configuration error
 * that construction can raise. resolveConfiguredBackends throws an
 * UnknownBackendError — an English adapter-layer error deliberately outside
 * the retryable hierarchy — when claims.json names a backend this build has
 * no adapter for. Every run (extraction, verification, relevance, research)
 * resolves its orchestrator through here so that failure surfaces as one
 * German precondition, never as a raw crash on a page.
 */
export function buildProjectOrchestrator(config: ProjectConfig): Orchestrator {
  try {
    return createProjectOrchestrator(config);
  } catch (error) {
    if (error instanceof UnknownBackendError) {
      throw new BackendUnavailableError(
        `Backend „${error.cli}" ist nicht verfügbar und kann nicht ` +
          "gestartet werden – bitte in den Einstellungen ein installiertes " +
          "Backend wählen.",
        { cause: error },
      );
    }
    throw error;
  }
}
