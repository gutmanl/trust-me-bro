import type { Backend, ProcessRunner } from "../core/contracts";
import { createClaudeBackend } from "../backends/claude/claude-backend";
import { createCodexBackend } from "../backends/codex/codex-backend";
import { getCachedLoginProbe, setCachedLoginProbe } from "./cache";
import {
  buildBackendHealth,
  probeLogin,
  probePresenceAndVersion,
} from "./probe";
import { probeSpecFor } from "./specs";
import type { BackendHealth, ProbeResult } from "./types";

/**
 * Facade of the preflight module (TMB-49): stages 1+2 always fresh (free),
 * stage 3 from the process-global cache until the on-demand probe refreshes
 * it. The pipeline consumes only this surface.
 */

export interface CliHealthDependencies {
  readonly runner?: ProcessRunner;
  /** Test seam for stage 3; production builds the real CLI backend. */
  readonly backend?: Backend;
}

function unknownCliHealth(cli: string): BackendHealth {
  const detail = `Kein Adapter für Backend-CLI "${cli}" registriert.`;
  const failed: ProbeResult = {
    stage: "on_path",
    status: "failed",
    detail,
    hint: "Projektkonfiguration prüfen (bekannte CLIs: claude, codex).",
  };
  return buildBackendHealth(
    cli,
    failed,
    { stage: "version_ok", status: "unknown", detail },
    undefined,
  );
}

/** Stages 1+2 fresh plus the cached stage-3 result. */
export async function checkCliHealth(
  cli: string,
  deps: CliHealthDependencies = {},
): Promise<BackendHealth> {
  const spec = probeSpecFor(cli);
  if (!spec) {
    return unknownCliHealth(cli);
  }
  const { onPath, version } = await probePresenceAndVersion(spec, deps.runner);
  return buildBackendHealth(cli, onPath, version, getCachedLoginProbe(cli));
}

/** Runs the quota-spending stage-3 probe, caches and returns fresh health. */
export async function runCliLoginProbe(
  cli: string,
  deps: CliHealthDependencies = {},
): Promise<BackendHealth> {
  const spec = probeSpecFor(cli);
  if (!spec) {
    return unknownCliHealth(cli);
  }
  const backend =
    deps.backend ??
    (spec.cli === "claude"
      ? createClaudeBackend(deps.runner ? { processRunner: deps.runner } : {})
      : createCodexBackend(deps.runner ? { processRunner: deps.runner } : {}));
  const login = await probeLogin(spec, backend);
  setCachedLoginProbe(cli, login);
  const { onPath, version } = await probePresenceAndVersion(spec, deps.runner);
  return buildBackendHealth(cli, onPath, version, login);
}

export type {
  BackendHealth,
  ProbeResult,
  ProbeStageId,
  ProbeStatus,
} from "./types";
export { __resetLoginProbeCacheForTests } from "./cache";
