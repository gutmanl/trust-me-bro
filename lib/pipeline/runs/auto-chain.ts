import { startSourceExtraction } from "../extraction/run-source-extraction";
import { startExistenceCheck } from "../verification/run-existence-check";
import { getGlobalJobRunner } from "./job-runner";
import type { JobRunner } from "./job-runner";

type PendingTrigger =
  { kind: "extraction"; sourceId: string } | { kind: "existence_check" };

function sameTrigger(a: PendingTrigger, b: PendingTrigger): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  return a.kind === "extraction"
    ? a.sourceId === (b as { kind: "extraction"; sourceId: string }).sourceId
    : true;
}

function describeTrigger(trigger: PendingTrigger): string {
  return trigger.kind === "extraction"
    ? `extraction (source "${trigger.sourceId}")`
    : "existence check";
}

export interface AutoChainDependencies {
  runner?: JobRunner;
  startSourceExtraction?: typeof startSourceExtraction;
  startExistenceCheck?: typeof startExistenceCheck;
}

export interface AutoChain {
  enqueueSourceExtraction(projectId: string, sourceId: string): void;
  enqueueExistenceCheck(projectId: string): void;
  /** Backlog length for a project — for UI/status, not a control surface. */
  pendingTriggerCount(projectId: string): number;
}

/**
 * Per-project FIFO in front of the UNMODIFIED single-writer JobRunner
 * (workbench epic): a source captured (or a briefing revision publishing)
 * must chain "extract that source's claims → run the existence check"
 * automatically, and STRICTLY SEQUENTIALLY per project — sequential
 * extraction is a correctness requirement, since each pass's prompt embeds
 * every previously created claim for dedupe, so two extraction passes for
 * the same project can never race each other.
 *
 * In-memory only, like the runner itself: a server restart drops whatever
 * was still queued. That is safe because nothing here is the durable truth —
 * claim statuses already record exactly what stage-1 still needs to see
 * (`captured` / `recheck_required`), the existence check re-derives its own
 * worklist from those statuses on every run, and a manual "re-extract this
 * source" action always exists as a human-triggered recovery. A dropped
 * trigger therefore never loses data, only a moment of automation.
 */
export function createAutoChain(deps: AutoChainDependencies = {}): AutoChain {
  const runner = deps.runner ?? getGlobalJobRunner();
  const runSourceExtraction =
    deps.startSourceExtraction ?? startSourceExtraction;
  const runExistenceCheck = deps.startExistenceCheck ?? startExistenceCheck;

  const pending = new Map<string, PendingTrigger[]>();
  const draining = new Set<string>();

  /** Pops the next trigger and silently drops any consecutive duplicates
   * behind it (same kind AND, for extraction, same sourceId) — several
   * captures or revisions firing in a burst collapse into one pass instead
   * of repeating identical work. */
  function dequeueCoalesced(
    queue: PendingTrigger[],
  ): PendingTrigger | undefined {
    const first = queue.shift();
    if (!first) {
      return undefined;
    }
    while (queue.length > 0 && sameTrigger(queue[0], first)) {
      queue.shift();
    }
    return first;
  }

  async function runTrigger(
    projectId: string,
    queue: PendingTrigger[],
    trigger: PendingTrigger,
  ): Promise<void> {
    if (trigger.kind === "extraction") {
      const handle = await runSourceExtraction(projectId, trigger.sourceId, {
        runner,
      });
      await handle.done;
      // An extraction pass always leaves fresh `captured` claims behind, so
      // the existence check must run before anything else queued for this
      // project — pushed to the FRONT, ahead of whatever is already
      // waiting, exactly as the brief requires.
      queue.unshift({ kind: "existence_check" });
    } else {
      const handle = await runExistenceCheck(projectId, { runner });
      await handle.done;
    }
  }

  async function drain(projectId: string): Promise<void> {
    try {
      // Event-driven, never polled: the only thing this loop ever awaits is
      // either the currently active run's `.done` or a trigger's own
      // `.done` — both settle exactly once, so there is no sleep/interval
      // anywhere in this path.
      while (true) {
        const queue = pending.get(projectId);
        if (!queue || queue.length === 0) {
          break;
        }

        try {
          const active = runner.currentRun(projectId);
          if (active?.isActive()) {
            await active.done;
          }
        } catch (error) {
          console.warn(
            `auto-chain: waiting for the active run on project "${projectId}" failed`,
            error,
          );
        }

        const trigger = dequeueCoalesced(queue);
        if (!trigger) {
          continue;
        }

        try {
          await runTrigger(projectId, queue, trigger);
        } catch (error) {
          console.warn(
            `auto-chain: ${describeTrigger(trigger)} failed for project "${projectId}"`,
            error,
          );
        }
      }
    } finally {
      pending.delete(projectId);
      draining.delete(projectId);
    }
  }

  function push(projectId: string, trigger: PendingTrigger): void {
    const queue = pending.get(projectId);
    if (queue) {
      queue.push(trigger);
    } else {
      pending.set(projectId, [trigger]);
    }
    if (!draining.has(projectId)) {
      draining.add(projectId);
      void drain(projectId);
    }
  }

  return {
    enqueueSourceExtraction(projectId, sourceId) {
      push(projectId, { kind: "extraction", sourceId });
    },
    enqueueExistenceCheck(projectId) {
      push(projectId, { kind: "existence_check" });
    },
    pendingTriggerCount(projectId) {
      return pending.get(projectId)?.length ?? 0;
    },
  };
}

/** Process-global chain, mirroring the runner's own singleton-with-factory
 * (getGlobalJobRunner): the app layer calls the three bound functions below;
 * tests use createAutoChain directly with injected fakes. */
let globalChain: AutoChain | undefined;

function getGlobalAutoChain(): AutoChain {
  globalChain ??= createAutoChain();
  return globalChain;
}

export function enqueueSourceExtraction(
  projectId: string,
  sourceId: string,
): void {
  getGlobalAutoChain().enqueueSourceExtraction(projectId, sourceId);
}

export function enqueueExistenceCheck(projectId: string): void {
  getGlobalAutoChain().enqueueExistenceCheck(projectId);
}

export function pendingTriggerCount(projectId: string): number {
  return getGlobalAutoChain().pendingTriggerCount(projectId);
}
