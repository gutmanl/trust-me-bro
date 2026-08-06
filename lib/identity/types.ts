/**
 * Actor identifiers as they appear in `history[]` and `project_events[]`
 * entries of claims.json (file format appendix, normative).
 */
export type HumanActorId = `human:${string}`;
export type SystemActorId = `system:${string}`;
export type ActorId = HumanActorId | SystemActorId;

export interface IdentityConfig {
  /** Short handle of the local user, e.g. "lg" → actor "human:lg". */
  actorKuerzel: string;
  /** Absolute path of the workspace root (one project directory per project). */
  workspaceRoot: string;
}

/**
 * Runtime configuration of the adapter layer (TMB-19): operational tuning,
 * deliberately NOT part of claims.json — the trace log records what actually
 * happened per attempt, which is what reproducibility needs.
 */
export interface AdapterConfig {
  /** Per-attempt child-process timeout. */
  timeoutMs: number;
  /** Total attempts per job (first try + retries) before escalation. */
  maxAttempts: number;
  /** Base of the exponential backoff between retries. */
  retryBaseDelayMs: number;
  /** Global cap on concurrent CLI child processes (subscription quota). */
  maxConcurrency: number;
}
