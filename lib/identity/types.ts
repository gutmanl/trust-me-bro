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
