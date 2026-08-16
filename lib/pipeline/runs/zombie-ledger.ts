/**
 * Abandoned-step tracking (run visibility, mid-step abandon).
 *
 * Cancel and the trigger deadline finalize a run or chain trigger
 * IMMEDIATELY — the user is never held hostage by a step that may never
 * settle. The in-flight step's promise cannot be stopped, though: it keeps
 * running in the background as a "zombie" until it settles on its own.
 * That reopens exactly one invariant: two passes of the SAME kind for the
 * SAME project must never overlap (extraction is the concrete case — each
 * pass's prompt embeds every previously created claim for dedupe, so a
 * zombie extraction racing a fresh one could mint duplicates).
 *
 * So the rule is scoped as narrowly as the invariant: a NEW start of kind
 * K for project P first waits for P's zombies OF KIND K to settle —
 * nothing else waits for anything. A cancelled anchor sweep never delays a
 * queued capture; a cancelled extraction only delays the next extraction.
 *
 * Owned per host instance (the runner tracks its abandoned steps, the
 * chain its abandoned triggers), not process-global on its own: the hosts
 * are already process-global, and an instance-owned ledger is what keeps
 * unit tests — which build fresh hosts per test — from seeing each other's
 * zombies.
 *
 * A zombie's own durable writes are deliberately not suppressed: they land
 * through the same TOCTOU-guarded transactions as always, with their real
 * timestamps — the audit trail records what actually happened, including
 * that it happened after the cancel. The settlement is logged so the
 * server log tells the same story.
 */
export interface ZombieLedger {
  track(projectId: string, kind: string, work: Promise<unknown>): void;
  /**
   * A promise settling when every tracked zombie of (project, kind) has —
   * or `undefined` when there are none, WITHOUT allocating: the caller can
   * then skip its `await` entirely and keep running synchronously, which
   * the runner's submit-to-first-step contract depends on.
   */
  pending(projectId: string, kind: string): Promise<void> | undefined;
}

function keyOf(projectId: string, kind: string): string {
  return `${projectId}\n${kind}`;
}

export function createZombieLedger(): ZombieLedger {
  const zombies = new Map<string, Set<Promise<unknown>>>();
  return {
    track(projectId, kind, work) {
      const key = keyOf(projectId, kind);
      let set = zombies.get(key);
      if (!set) {
        set = new Set();
        zombies.set(key, set);
      }
      set.add(work);
      const untrack = () => {
        set.delete(work);
        if (set.size === 0) {
          zombies.delete(key);
        }
      };
      work.then(
        () => {
          console.warn(
            `abandoned ${kind} step for project "${projectId}" settled ` +
              "late (succeeded); its outcome was not counted by the " +
              "cancelled run, but any durable writes it made are recorded.",
          );
          untrack();
        },
        (error: unknown) => {
          console.warn(
            `abandoned ${kind} step for project "${projectId}" settled ` +
              "late (failed); nothing was waiting on it.",
            error,
          );
          untrack();
        },
      );
    },
    pending(projectId, kind) {
      const set = zombies.get(keyOf(projectId, kind));
      if (!set || set.size === 0) {
        return undefined;
      }
      // Loop rather than one allSettled: a zombie settling can in principle
      // be joined by another abandon in the meantime; re-read until empty.
      return (async () => {
        for (;;) {
          const current = zombies.get(keyOf(projectId, kind));
          if (!current || current.size === 0) {
            return;
          }
          await Promise.allSettled([...current]);
        }
      })();
    },
  };
}
