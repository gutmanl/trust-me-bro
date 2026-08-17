import { loadAnthropicApiKey, loadFeatureFlags } from "../../identity";
import type { Backend, ProcessRunner } from "../core/contracts";
import { createAnthropicApiBackend } from "../backends/anthropic-api/anthropic-api-backend";
import { createClaudeBackend } from "../backends/claude/claude-backend";
import { createCodexBackend } from "../backends/codex/codex-backend";
import { getCachedLoginProbe, setCachedLoginProbe } from "./cache";
import {
  buildBackendHealth,
  probeLogin,
  probePresenceAndVersion,
} from "./probe";
import { probeSpecFor } from "./specs";
import type { BackendHealth, ProbeResult, ProbeStageId } from "./types";

/**
 * Facade of the preflight module (TMB-49): stages 1+2 always fresh (free),
 * stage 3 from the process-global cache until the on-demand probe refreshes
 * it. The pipeline consumes only this surface. The API spike backend
 * (TMB-51) has differently-shaped readiness stages — feature flag and API
 * key instead of PATH and version — mirroring the registry's double gate.
 */

export interface CliHealthDependencies {
  readonly runner?: ProcessRunner;
  /** Test seam for stage 3; production builds the real backend. */
  readonly backend?: Backend;
}

const API_BACKEND_CLI = "anthropic-api";
const DEMO_BACKEND_CLI = "mock";
const API_LOGIN_HINT =
  "Testaufruf gescheitert – ANTHROPIC_API_KEY prüfen (gültig? Guthaben?).";

function unknownCliHealth(cli: string): BackendHealth {
  const detail = `Für die CLI "${cli}" ist keine Unterstützung eingebaut.`;
  const failed: ProbeResult = {
    stage: "on_path",
    status: "failed",
    detail,
    hint: "Projektkonfiguration prüfen (bekannte CLIs: claude, codex, mock).",
  };
  return buildBackendHealth(
    cli,
    failed,
    { stage: "version_ok", status: "unknown", detail },
    undefined,
  );
}

/** Stages 1+2 of the API spike backend: the registry's double gate,
 * reported as findings with targeted hints. */
function apiBackendStages(): { onPath: ProbeResult; version: ProbeResult } {
  const checkedAt = new Date().toISOString();
  const flagOn = loadFeatureFlags().apiBackendEnabled;
  const hasKey = loadAnthropicApiKey() !== undefined;
  return {
    onPath: {
      stage: "on_path",
      title: "Stufe 1 – Feature-Flag aktiv",
      status: flagOn ? "ok" : "failed",
      detail: flagOn
        ? "TMB_ENABLE_API_BACKEND=1 gesetzt."
        : "Feature-Flag TMB_ENABLE_API_BACKEND nicht gesetzt.",
      ...(flagOn
        ? {}
        : { hint: "TMB_ENABLE_API_BACKEND=1 setzen (Spike-Backend, TMB-51)." }),
      checkedAt,
    },
    version: {
      stage: "version_ok",
      title: "Stufe 2 – API-Schlüssel vorhanden",
      status: hasKey ? "ok" : "failed",
      detail: hasKey
        ? "ANTHROPIC_API_KEY vorhanden."
        : "ANTHROPIC_API_KEY fehlt.",
      ...(hasKey ? {} : { hint: "ANTHROPIC_API_KEY setzen." }),
      checkedAt,
    },
  };
}

/** All three stages of the demonstration backend: it runs in-process with
 * canned outputs, so there is nothing to find on PATH, no version to read
 * and no account to probe — every stage is ok by construction. */
function demoBackendHealth(): BackendHealth {
  const checkedAt = new Date().toISOString();
  const ok = (
    stage: ProbeStageId,
    title: string,
    detail: string,
  ): ProbeResult => ({ stage, title, status: "ok", detail, checkedAt });
  return buildBackendHealth(
    DEMO_BACKEND_CLI,
    ok(
      "on_path",
      "Stufe 1 – kein Programm nötig",
      "Das Demo-Backend läuft im Prozess der Anwendung.",
    ),
    ok(
      "version_ok",
      "Stufe 2 – keine Version nötig",
      "Fest eingebaut, keine externe Installation.",
    ),
    ok(
      "login_ok",
      "Stufe 3 – keine Anmeldung nötig",
      "Liefert vorgefertigte Ergebnisse, ohne Konto und ohne Kontingent.",
    ),
  );
}

/** Stages 1+2 fresh plus the cached stage-3 result. */
export async function checkCliHealth(
  cli: string,
  deps: CliHealthDependencies = {},
): Promise<BackendHealth> {
  if (cli === DEMO_BACKEND_CLI) {
    return demoBackendHealth();
  }
  if (cli === API_BACKEND_CLI) {
    const { onPath, version } = apiBackendStages();
    return buildBackendHealth(cli, onPath, version, getCachedLoginProbe(cli));
  }
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
  if (cli === DEMO_BACKEND_CLI) {
    return demoBackendHealth();
  }
  if (cli === API_BACKEND_CLI) {
    const { onPath, version } = apiBackendStages();
    const apiKey = loadAnthropicApiKey();
    if (
      deps.backend === undefined &&
      (!loadFeatureFlags().apiBackendEnabled || apiKey === undefined)
    ) {
      // Gate closed: report the failing stages instead of probing.
      return buildBackendHealth(cli, onPath, version, getCachedLoginProbe(cli));
    }
    const backend =
      deps.backend ?? createAnthropicApiBackend({ apiKey: apiKey ?? "" });
    const login = await probeLogin({ loginHint: API_LOGIN_HINT }, backend);
    setCachedLoginProbe(cli, login);
    return buildBackendHealth(cli, onPath, version, login);
  }
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
