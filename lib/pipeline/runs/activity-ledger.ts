import { processGlobal } from "../../process-global";

/**
 * The single arbiter of "who currently holds this project's single-writer
 * seat" (run visibility).
 *
 * The job runner and the auto-chain each keep rich private bookkeeping —
 * the runner its `active` map and per-run event logs, the chain its
 * backlog, drain lock and in-flight capture item. What neither could
 * answer before this module existed is the one question every guard and
 * every status surface actually asks: IS something occupying this project
 * right now, and if so what, since when, and how do I cancel it. The
 * runner's answer ignored the chain's off-runner triggers; the chain's
 * answer ignored the runner — two state machines read by disjoint callers,
 * which is precisely how work became invisible and uncancellable while
 * still blocking everything (the incident this module exists because of).
 *
 * A leaf on purpose: it imports nothing from either registrant, so
 * auto-chain (which already imports job-runner) can import it without any
 * new cycle, and the lazy-resolution seam the chain keeps for the repair
 * modules stays untouched.
 */
export interface ActivityEntry {
  /** runId or triggerId. */
  activityId: string;
  projectId: string;
  source: "run" | "trigger";
  /** Runner kind ("extraction", …) or OffRunnerTriggerKind. */
  kind: string;
  /** German, ready for the status bar and for blocked-action messages. */
  description: string;
  startedAt: string;
  isActive(): boolean;
  requestCancel(): boolean;
}

export interface ActivityLedger {
  /**
   * Registers the occupant; returns the deregistration function. Throws if
   * the project already has a LIVE occupant — both registrants serialize
   * per project by construction, so a collision is a bug, and failing
   * loudly beats silently overwriting one occupant with another (which
   * would detach its cancel path).
   */
  register(entry: ActivityEntry): () => void;
  /** The live occupant, if any. Self-heals: an entry whose `isActive()`
   * has gone false is dropped on read, so a registrant that failed to
   * deregister (the exact leak class this system fixes) can block at most
   * until its own activity flag clears. */
  current(projectId: string): ActivityEntry | undefined;
}

export function createActivityLedger(): ActivityLedger {
  const entries = new Map<string, ActivityEntry>();
  return {
    register(entry) {
      const existing = entries.get(entry.projectId);
      if (existing && existing.isActive()) {
        throw new Error(
          `activity ledger: project "${entry.projectId}" already occupied ` +
            `by ${existing.source} "${existing.activityId}" while ` +
            `${entry.source} "${entry.activityId}" tried to register`,
        );
      }
      entries.set(entry.projectId, entry);
      return () => {
        if (entries.get(entry.projectId) === entry) {
          entries.delete(entry.projectId);
        }
      };
    },
    current(projectId) {
      const entry = entries.get(projectId);
      if (!entry) {
        return undefined;
      }
      if (!entry.isActive()) {
        entries.delete(projectId);
        return undefined;
      }
      return entry;
    },
  };
}

/** Process-global ledger, anchored like the runner and the chain — the
 * three MUST share one process instance or the unified view splits into
 * exactly the two disjoint views it replaces. */
export function getGlobalActivityLedger(): ActivityLedger {
  return processGlobal("runs/activity-ledger", createActivityLedger);
}
