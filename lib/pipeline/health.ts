import { checkCliHealth, runCliLoginProbe } from "../adapters";
import type { BackendHealth } from "../adapters";
import type { ProjectConfig } from "../register";
import { requireProjectStore } from "./projects";

/**
 * Backend health as the web layer and the run preconditions consume it
 * (TMB-49). Stages 1+2 are recomputed on every call (free); stage 3 comes
 * from the adapter layer's login-probe cache until its on-demand button
 * refreshes it.
 */

export interface ProjectBackendsHealth {
  primary: BackendHealth;
  secondary?: BackendHealth;
}

/** Test seam: the adapter-layer facade functions, injectable per call. */
export interface HealthDependencies {
  check?: typeof checkCliHealth;
  probe?: typeof runCliLoginProbe;
}

export async function getBackendsHealth(
  projectId: string,
  deps: HealthDependencies = {},
): Promise<ProjectBackendsHealth> {
  const check = deps.check ?? checkCliHealth;
  const register = await requireProjectStore(projectId).read();
  const secondaryCli = register.config.backends.secondary?.cli;
  const [primary, secondary] = await Promise.all([
    check(register.config.backends.primary.cli),
    secondaryCli === undefined ? undefined : check(secondaryCli),
  ]);
  return { primary, ...(secondary === undefined ? {} : { secondary }) };
}

/** The quota-spending stage-3 probe, triggered by the status page button. */
export async function runLoginProbe(
  projectId: string,
  which: "primary" | "secondary",
  deps: HealthDependencies = {},
): Promise<BackendHealth> {
  const probe = deps.probe ?? runCliLoginProbe;
  const register = await requireProjectStore(projectId).read();
  const cli =
    which === "primary"
      ? register.config.backends.primary.cli
      : register.config.backends.secondary?.cli;
  if (cli === undefined) {
    // No secondary configured: report the absence instead of probing.
    return {
      cli: "(kein sekundäres Backend)",
      stages: [
        {
          stage: "on_path",
          status: "unknown",
          detail: "Kein sekundäres Backend konfiguriert.",
        },
        {
          stage: "version_ok",
          status: "unknown",
          detail: "Kein sekundäres Backend konfiguriert.",
        },
        {
          stage: "login_ok",
          status: "unknown",
          detail: "Kein sekundäres Backend konfiguriert.",
        },
      ],
      usable: false,
    };
  }
  return probe(cli);
}

/**
 * Preflight seam of the run use-cases: answers "may an LLM run start against
 * this CLI" from the free stages 1+2. Injected in tests; the runs default to
 * a permissive answer exactly when a test orchestrator is injected (a mock
 * orchestrator never talks to real CLIs, so probing them would be
 * meaningless there).
 */
export type BackendPreflight = (
  cli: string,
) => Promise<{ usable: boolean; hint?: string }>;

export async function probeBackendUsable(
  cli: string,
  check: typeof checkCliHealth = checkCliHealth,
): Promise<{ usable: boolean; hint?: string }> {
  const health = await check(cli);
  if (health.usable) {
    return { usable: true };
  }
  const firstFailure = health.stages.find((stage) => stage.status === "failed");
  return {
    usable: false,
    hint:
      firstFailure?.hint ??
      firstFailure?.detail ??
      "Backend nicht einsatzbereit.",
  };
}

export const permissiveBackendPreflight: BackendPreflight = async () => ({
  usable: true,
});

/**
 * Effective config for a run whose secondary backend failed preflight
 * (TMB-49 graceful degradation): the divergence rule is disabled for this
 * run only — the saved project settings stay untouched, the run event notes
 * the degradation visibly.
 */
export function withoutSecondaryBackend(config: ProjectConfig): ProjectConfig {
  const { backends, ...rest } = config;
  return {
    ...rest,
    backends: { primary: backends.primary },
  };
}
