/**
 * Actor identifiers as they appear in `history[]` and `project_events[]`
 * entries of claims.json (file format appendix, normative).
 */
export type HumanActorId = `human:${string}`;
export type SystemActorId = `system:${string}`;
export type ActorId = HumanActorId | SystemActorId;

export interface IdentityConfig {
  /** Short handle of the local user, e.g. "lg" → actor "human:lg". */
  actorHandle: string;
  /** Absolute path of the workspace root (one project directory per project). */
  workspaceRoot: string;
}

/**
 * Feature flags of the prototype (TMB-51). Deliberately explicit booleans:
 * an experimental path must never activate silently just because some
 * unrelated tool exported an environment variable.
 */
export interface FeatureFlags {
  /** The API-backend spike (Anthropic Messages API adapter). Off = the
   * prototype runs unchanged without any API key. */
  apiBackendEnabled: boolean;
}

/**
 * The configured Unpaywall contact address (reference auto-import, Task
 * 3b): Unpaywall requires an e-mail with every request as its required
 * identification. Optional, installation-level setting — "unset" is a
 * normal, fully-supported state (the document-url derivation simply skips
 * the Unpaywall step). The source discriminator lets the UI tell an
 * env-provided address (read-only there) from a stored, user-editable one.
 */
export interface UnpaywallSetting {
  email: string | null;
  source: "env" | "config" | "unset";
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
