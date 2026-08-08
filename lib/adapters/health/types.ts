/**
 * Preflight diagnosis of the CLI backends (TMB-49, Grobentwurf
 * "Installation, Start und Robustheit"): three stages per backend, each
 * with a finding and a targeted setup hint instead of a generic error.
 */

export type ProbeStageId = "on_path" | "version_ok" | "login_ok";

/** "unknown" = not determinable / not yet run (stage 3 before its button). */
export type ProbeStatus = "ok" | "failed" | "unknown";

export interface ProbeResult {
  readonly stage: ProbeStageId;
  readonly status: ProbeStatus;
  /** Finding, e.g. "claude 2.1.223 gefunden". */
  readonly detail: string;
  /** Targeted German setup hint when not ok. */
  readonly hint?: string;
  /** ISO timestamp; absent for a never-probed stage 3. */
  readonly checkedAt?: string;
}

export interface BackendHealth {
  readonly cli: string;
  /** Fixed order: on_path, version_ok, login_ok. */
  readonly stages: readonly [ProbeResult, ProbeResult, ProbeResult];
  /**
   * on_path && version_ok — cheap and free, safe to recompute on every page
   * load / run start.
   */
  readonly usable: boolean;
}
