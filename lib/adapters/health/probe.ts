import os from "node:os";

import type { Backend, ProcessRunner } from "../core/contracts";
import { AdapterError, AdapterRateLimitError } from "../core/errors";
import type { AttributionInput } from "../core/jobs";
import { renderPromptForJob } from "../prompts";
import { nodeProcessRunner } from "../runtime/node-process-runner";
import type { CliProbeSpec } from "./specs";
import type { BackendHealth, ProbeResult } from "./types";

/**
 * The three probe stages of TMB-49. Stages 1+2 share ONE `<cli> --version`
 * child process through the sanctioned runner (free, no LLM call); stage 3
 * is a real, minimal call through the normal adapter path — Backend.invoke
 * directly, deliberately WITHOUT the orchestrator: a login probe wants one
 * fast, non-retried answer, not three attempts with backoff.
 */

const VERSION_PROBE_TIMEOUT_MS = 15_000;
/** Generous enough for a cold CLI start, far below the job timeout. */
const LOGIN_PROBE_TIMEOUT_MS = 120_000;

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;

/**
 * Minimal synthetic attribution job (the smallest job kind): a trivial
 * claim/evidence pair against a scratch directory — the probe never touches
 * a real project and spends only a few tokens of quota.
 */
const PROBE_INPUT: AttributionInput = {
  claim: {
    id: "clm_probe",
    text: "Die Datei nennt den Wert 42.",
    claim_type: "quantitative_finding",
    briefing_anchor: "probe",
  },
  evidence: {
    id: "ev_probe",
    source_id: "src_probe",
    source_type: "grey_literature",
    locator: { section: "Probe" },
    verbatim_excerpt: "Der Wert betraegt 42.",
  },
};

/** Stages 1+2 from one --version invocation. */
export async function probePresenceAndVersion(
  spec: CliProbeSpec,
  runner: ProcessRunner = nodeProcessRunner,
): Promise<{ onPath: ProbeResult; version: ProbeResult }> {
  const checkedAt = new Date().toISOString();
  const result = await runner.run({
    command: spec.command,
    args: [...spec.versionArgs],
    cwd: os.tmpdir(),
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
  });

  // The runner never rejects: a spawn failure resolves with exitCode null
  // and "spawn failed: …" on stderr (node-process-runner contract).
  if (result.exitCode === null || result.timedOut) {
    return {
      onPath: {
        stage: "on_path",
        status: "failed",
        detail: result.timedOut
          ? `${spec.command} --version reagiert nicht (Timeout).`
          : `${spec.command} nicht im Suchpfad gefunden.`,
        hint: spec.installHint,
        checkedAt,
      },
      version: {
        stage: "version_ok",
        status: "unknown",
        detail: "Nicht prüfbar, solange die CLI nicht startet.",
        checkedAt,
      },
    };
  }

  const onPath: ProbeResult = {
    stage: "on_path",
    status: "ok",
    detail: `${spec.command} im Suchpfad gefunden.`,
    checkedAt,
  };
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const match = VERSION_PATTERN.exec(output);
  if (result.exitCode !== 0 || !match) {
    // Lenient by design: an unparsable version blocks nothing — the CLI
    // likely still works, version formats are not a stable contract.
    return {
      onPath,
      version: {
        stage: "version_ok",
        status: result.exitCode === 0 ? "unknown" : "failed",
        detail:
          result.exitCode === 0
            ? `Version nicht ermittelbar aus "${output.slice(0, 120)}".`
            : `--version endete mit Code ${result.exitCode}.`,
        ...(result.exitCode === 0 ? {} : { hint: spec.installHint }),
        checkedAt,
      },
    };
  }

  const found: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const compatible = compareVersions(found, spec.minVersion) >= 0;
  return {
    onPath,
    version: {
      stage: "version_ok",
      status: compatible ? "ok" : "failed",
      detail: `${spec.command} ${found.join(".")} gefunden (Minimum ${spec.minVersion.join(".")}).`,
      ...(compatible
        ? {}
        : {
            hint: `Version zu alt – aktualisieren, z. B. ${spec.installHint}`,
          }),
      checkedAt,
    },
  };
}

/**
 * Stage 3: one real minimal call through the given backend. Success and
 * schema-deviant-but-produced output both prove a working login; only
 * process failures/timeouts read as "not logged in / not responding", and
 * a rate limit is reported distinctly (the login itself works). Takes only
 * the login hint so the API backend (which has no CLI probe spec) can reuse
 * the same probe (TMB-51).
 */
export async function probeLogin(
  spec: Pick<CliProbeSpec, "loginHint">,
  backend: Backend,
): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();
  try {
    const result = await backend.invoke({
      kind: "attribution",
      projectDir: os.tmpdir(),
      input: PROBE_INPUT,
      prompt: renderPromptForJob("attribution", PROBE_INPUT),
      timeoutMs: LOGIN_PROBE_TIMEOUT_MS,
    });
    return {
      stage: "login_ok",
      status: "ok",
      detail: `Anmeldung funktionsfähig (Testaufruf beantwortet, Modell ${result.model}).`,
      checkedAt,
    };
  } catch (error) {
    if (error instanceof AdapterRateLimitError) {
      return {
        stage: "login_ok",
        status: "failed",
        detail: `Angemeldet, aber Rate-Limit aktiv: ${error.detail.slice(0, 160)}`,
        hint: "Rate-Limit während der Prüfung – später erneut versuchen.",
        checkedAt,
      };
    }
    if (error instanceof AdapterError && error.kind === "invalid_output") {
      // The CLI ran and produced output — authentication works, only the
      // payload deviated from the probe schema.
      return {
        stage: "login_ok",
        status: "ok",
        detail:
          "Anmeldung funktionsfähig (Testaufruf beantwortet, Ausgabe wich " +
          "vom Probeschema ab).",
        checkedAt,
      };
    }
    if (error instanceof AdapterError) {
      return {
        stage: "login_ok",
        status: "failed",
        detail: `Testaufruf gescheitert: ${error.message.slice(0, 200)}`,
        hint: spec.loginHint,
        checkedAt,
      };
    }
    throw error;
  }
}

/** Assembles stages 1+2 (fresh) with a given stage-3 result (cache or run). */
export function buildBackendHealth(
  cli: string,
  onPath: ProbeResult,
  version: ProbeResult,
  login: ProbeResult | undefined,
): BackendHealth {
  const loginResult: ProbeResult = login ?? {
    stage: "login_ok",
    status: "unknown",
    detail:
      "Noch nicht geprüft – Testaufruf kostet einen kleinen Kontingentanteil.",
  };
  return {
    cli,
    stages: [onPath, version, loginResult],
    usable: onPath.status === "ok" && version.status !== "failed",
  };
}

function compareVersions(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}
