import { startSourceExtraction } from "../extraction/run-source-extraction";
import type { startAutoReferenceCapture } from "../sources/reference-scan/run-auto-reference-capture";
import type { startReferenceScan } from "../sources/reference-scan/run-reference-scan";
import type { startSourceCaptureItem } from "../sources/work-items/run-item";
import type {
  SourceCaptureItemInfo,
  SourceCaptureWorkItem,
} from "../sources/work-items/types";
import { startExistenceCheck } from "../verification/run-existence-check";
import { getGlobalJobRunner } from "./job-runner";
import type { JobRunner } from "./job-runner";

type PendingTrigger =
  | { kind: "extraction"; sourceId: string }
  | { kind: "existence_check" }
  | { kind: "reference_scan" }
  | { kind: "reference_capture" }
  | { kind: "source_capture"; item: SourceCaptureWorkItem };

function sameTrigger(a: PendingTrigger, b: PendingTrigger): boolean {
  if (a.kind === "extraction" && b.kind === "extraction") {
    return a.sourceId === b.sourceId;
  }
  if (a.kind === "source_capture" && b.kind === "source_capture") {
    // Distinct work items are never duplicates; a same-id pair (a retry
    // enqueued twice in a burst) coalesces like a repeated extraction.
    return a.item.workItemId === b.item.workItemId;
  }
  return a.kind === b.kind;
}

function describeTrigger(trigger: PendingTrigger): string {
  switch (trigger.kind) {
    case "extraction":
      return `extraction (source "${trigger.sourceId}")`;
    case "existence_check":
      return "existence check";
    case "reference_scan":
      return "reference scan";
    case "reference_capture":
      return "automatic reference capture";
    case "source_capture":
      return `source capture (work item "${trigger.item.workItemId}")`;
  }
}

function itemInfo(item: SourceCaptureWorkItem): SourceCaptureItemInfo {
  return {
    workItemId: item.workItemId,
    origin: item.origin,
    label: item.label,
  };
}

export interface AutoChainDependencies {
  runner?: JobRunner;
  startSourceExtraction?: typeof startSourceExtraction;
  startExistenceCheck?: typeof startExistenceCheck;
  startReferenceScan?: typeof startReferenceScan;
  startAutoReferenceCapture?: typeof startAutoReferenceCapture;
  startSourceCaptureItem?: typeof startSourceCaptureItem;
}

export interface AutoChain {
  enqueueSourceExtraction(projectId: string, sourceId: string): void;
  enqueueExistenceCheck(projectId: string): void;
  enqueueReferenceScan(projectId: string): void;
  /** Queues one capture work item (source work items): manual capture and
   * reference-import captures both enter here, so they serialize with each
   * other and with every other run of the project. */
  enqueueSourceCapture(projectId: string, item: SourceCaptureWorkItem): void;
  /** Waiting-backlog length for a project — for UI/status, not a control
   * surface. See the exported `pendingTriggerCount` below for the full
   * contract (what "waiting" excludes, and why 0 does not mean idle). */
  pendingTriggerCount(projectId: string): number;
  /** The capture work items still WAITING in the backlog, in queue order —
   * subject to the same backlog-only caveat as `pendingTriggerCount`. */
  pendingCaptureItems(projectId: string): SourceCaptureItemInfo[];
  /** The capture work item whose trigger is currently in flight (popped off
   * the backlog, run not finished), if any — the "capturing" half the
   * backlog view cannot see. */
  activeCaptureItem(projectId: string): SourceCaptureItemInfo | undefined;
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
 * The same shape carries the second chain: a published briefing chains
 * "scan the briefing for its references → capture the ones that resolved
 * cleanly", from where the capture's own per-source extraction triggers
 * (run-reference-capture.ts) rejoin the chain above. Both chains share one
 * queue per project, which is what keeps them off each other's toes on the
 * single-writer runner.
 *
 * In-memory only, like the runner itself: a server restart drops whatever
 * was still queued. That is safe because nothing here is the durable truth —
 * claim statuses already record exactly what stage-1 still needs to see
 * (`captured` / `recheck_required`), the existence check re-derives its own
 * worklist from those statuses on every run, and a manual "re-extract this
 * source" action always exists as a human-triggered recovery. The reference
 * chain is drop-safe for the same reason: the scan and the capture both keep
 * their own manual buttons, and neither leaves half-written state behind.
 * A dropped trigger therefore never loses data, only a moment of automation.
 */
export function createAutoChain(deps: AutoChainDependencies = {}): AutoChain {
  const runner = deps.runner ?? getGlobalJobRunner();
  const runSourceExtraction =
    deps.startSourceExtraction ?? startSourceExtraction;
  const runExistenceCheck = deps.startExistenceCheck ?? startExistenceCheck;

  /**
   * The reference chain's two start-fns are the only ones resolved on first
   * use rather than imported at the top, for two reasons that happen to
   * point the same way.
   *
   * Correctness: the automatic capture reaches startReferenceCapture, and
   * THAT module imports `enqueueSourceExtraction` from here (its documented
   * per-item chaining exception) — a static import would close an import
   * cycle where today there is none.
   *
   * Weight: the scan pulls the whole adapter/orchestrator graph behind it,
   * and every module that touches this one (which is every source capture
   * path) would have paid for that graph at load time whether or not a
   * briefing was ever published.
   *
   * Both are cached after the first resolution, and tests inject the
   * dependency and never reach this path.
   */
  let referenceScan = deps.startReferenceScan;
  async function runReferenceScan(projectId: string) {
    referenceScan ??= (
      await import("../sources/reference-scan/run-reference-scan")
    ).startReferenceScan;
    return referenceScan(projectId, { runner });
  }

  let autoReferenceCapture = deps.startAutoReferenceCapture;
  async function runAutoReferenceCapture(projectId: string) {
    autoReferenceCapture ??= (
      await import("../sources/reference-scan/run-auto-reference-capture")
    ).startAutoReferenceCapture;
    return autoReferenceCapture(projectId, { runner });
  }

  // Lazily resolved for the same cycle reason as the reference chain above:
  // the capture item's step imports `enqueueSourceExtraction` from here (its
  // documented per-item chaining), so a static import would close a cycle.
  let sourceCaptureItem = deps.startSourceCaptureItem;
  async function runSourceCaptureItem(
    projectId: string,
    item: SourceCaptureWorkItem,
  ) {
    sourceCaptureItem ??= (
      await import("../sources/work-items/run-item")
    ).startSourceCaptureItem;
    return sourceCaptureItem(projectId, item, { runner });
  }

  const pending = new Map<string, PendingTrigger[]>();
  const draining = new Set<string>();
  /** The capture work item whose trigger is in flight, per project — set
   * just before its run is submitted, cleared when the trigger settles, so
   * status readers see "capturing" exactly while the backlog cannot. */
  const activeCapture = new Map<string, SourceCaptureItemInfo>();

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
    } else if (trigger.kind === "reference_scan") {
      const handle = await runReferenceScan(projectId);
      await handle.done;
      // Chained unconditionally, exactly like the existence check above:
      // whether the scan actually found anything worth capturing is the
      // capture's own question to answer against the committed scan result,
      // not something to decide from a run summary here.
      queue.unshift({ kind: "reference_capture" });
    } else if (trigger.kind === "reference_capture") {
      // No run at all when nothing resolved cleanly enough to capture
      // unattended — the common case for a briefing whose citations all
      // need a human. Not an error, so nothing is logged.
      const handle = await runAutoReferenceCapture(projectId);
      await handle?.done;
    } else if (trigger.kind === "source_capture") {
      activeCapture.set(projectId, itemInfo(trigger.item));
      try {
        const handle = await runSourceCaptureItem(projectId, trigger.item);
        await handle.done;
      } finally {
        activeCapture.delete(projectId);
      }
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
      // The loop only ever `break`s once its own queue read up top saw it
      // empty, so this is normally a no-op-safe cleanup. But if something
      // truly unexpected threw past every inner try/catch above, the queue
      // for this project can still be non-empty here — deleting it would
      // silently orphan those triggers (a later push() would start a FRESH
      // array, and the old one — with real pending work in it — would never
      // be looked at again). So only delete when the backlog is genuinely
      // empty; otherwise leave it in place and just drop the draining
      // guard, so the next enqueue for this project starts a fresh drain()
      // that picks the leftover triggers back up.
      const remaining = pending.get(projectId);
      if (!remaining || remaining.length === 0) {
        pending.delete(projectId);
      }
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
      // drain() catches every realistic failure internally (see the two
      // inner try/catches above); this .catch is a last-resort net so a
      // truly unexpected throw becomes a logged warning instead of an
      // unhandled promise rejection — drain() is fired-and-forgotten
      // (`void`), so nothing else is in a position to observe it reject.
      void drain(projectId).catch((error: unknown) => {
        console.warn(
          `auto-chain: drain loop for project "${projectId}" ended unexpectedly`,
          error,
        );
      });
    }
  }

  return {
    enqueueSourceExtraction(projectId, sourceId) {
      push(projectId, { kind: "extraction", sourceId });
    },
    enqueueExistenceCheck(projectId) {
      push(projectId, { kind: "existence_check" });
    },
    enqueueReferenceScan(projectId) {
      push(projectId, { kind: "reference_scan" });
    },
    enqueueSourceCapture(projectId, item) {
      push(projectId, { kind: "source_capture", item });
    },
    pendingTriggerCount(projectId) {
      return pending.get(projectId)?.length ?? 0;
    },
    pendingCaptureItems(projectId) {
      return (pending.get(projectId) ?? []).flatMap((trigger) =>
        trigger.kind === "source_capture" ? [itemInfo(trigger.item)] : [],
      );
    },
    activeCaptureItem(projectId) {
      return activeCapture.get(projectId);
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

/** Scans the freshly published briefing for its references and captures the
 * cleanly resolved ones — enqueued by the workbench's publish action, so a
 * briefing arrives with its own bibliography instead of an empty source
 * list. */
export function enqueueReferenceScan(projectId: string): void {
  getGlobalAutoChain().enqueueReferenceScan(projectId);
}

/** Queues one capture work item on the project's chain (source work items).
 * Callers hand in a fully prepared item — uploads already frozen as blobs —
 * so nothing heavier than a small object ever waits in the queue. */
export function enqueueSourceCapture(
  projectId: string,
  item: SourceCaptureWorkItem,
): void {
  getGlobalAutoChain().enqueueSourceCapture(projectId, item);
}

/** Waiting capture work items of a project, in queue order (backlog-only,
 * like `pendingTriggerCount` — the in-flight item is `activeCaptureItem`). */
export function pendingCaptureItems(
  projectId: string,
): SourceCaptureItemInfo[] {
  return getGlobalAutoChain().pendingCaptureItems(projectId);
}

/** The capture work item currently in flight for a project, if any. */
export function activeCaptureItem(
  projectId: string,
): SourceCaptureItemInfo | undefined {
  return getGlobalAutoChain().activeCaptureItem(projectId);
}

/**
 * Number of triggers still WAITING in the queue for a project — it excludes
 * whichever trigger (if any) is currently in flight, because `drain()` pops
 * a trigger off the backlog array before awaiting its start-fn/`.done`, not
 * after. Two consequences that make this an easy contract to misread:
 *
 * - A single enqueue with no run already active for the project can be
 *   dequeued and start running INSIDE the very `enqueueSourceExtraction`/
 *   `enqueueExistenceCheck` call that queued it (`drain()` runs synchronously
 *   up to its first real `await`) — so this can return 0 immediately after
 *   enqueuing, and stay 0 for the whole chain (extraction, its chained
 *   existence check, …) even though work is actively running.
 * - Conversely a positive count only ever means "N triggers have not
 *   started yet" — it says nothing about whether anything is CURRENTLY
 *   running.
 *
 * In short: 0 does not mean "auto-chain is idle for this project", and a
 * positive number does not mean "nothing has started". A caller that wants
 * to answer "is the auto-chain still doing something for this project" must
 * combine this with the job runner's own live state (`isRunning` /
 * `getActiveRun`), not read this count alone.
 */
export function pendingTriggerCount(projectId: string): number {
  return getGlobalAutoChain().pendingTriggerCount(projectId);
}
