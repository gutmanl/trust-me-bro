import { processGlobal } from "../../process-global";
import { startSourceExtraction } from "../extraction/run-source-extraction";
import type { buildAutoCaptureItems } from "../sources/reference-scan/enqueue-candidate-capture";
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
  | { kind: "source_capture"; item: SourceCaptureWorkItem }
  // Automatic repair (automatic repair): evaluation/sweep steps that run
  // BETWEEN runner runs — they submit no run of their own, so use-cases
  // guarded by isRunning (the briefing revision) stay callable from them.
  | { kind: "capture_failure_repair"; workItemId: string }
  | { kind: "source_repair_evaluation"; sourceId: string }
  | { kind: "anchor_repair" }
  | { kind: "briefing_substitution"; sourceId: string };

function sameTrigger(a: PendingTrigger, b: PendingTrigger): boolean {
  if (a.kind === "extraction" && b.kind === "extraction") {
    return a.sourceId === b.sourceId;
  }
  if (a.kind === "source_capture" && b.kind === "source_capture") {
    // Distinct work items are never duplicates; a same-id pair (a retry
    // enqueued twice in a burst) coalesces like a repeated extraction.
    return a.item.workItemId === b.item.workItemId;
  }
  if (
    a.kind === "capture_failure_repair" &&
    b.kind === "capture_failure_repair"
  ) {
    return a.workItemId === b.workItemId;
  }
  if (
    a.kind === "source_repair_evaluation" &&
    b.kind === "source_repair_evaluation"
  ) {
    return a.sourceId === b.sourceId;
  }
  if (
    a.kind === "briefing_substitution" &&
    b.kind === "briefing_substitution"
  ) {
    return a.sourceId === b.sourceId;
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
    case "source_capture":
      return `source capture (work item "${trigger.item.workItemId}")`;
    case "capture_failure_repair":
      return `capture-failure repair (work item "${trigger.workItemId}")`;
    case "source_repair_evaluation":
      return `source repair evaluation (source "${trigger.sourceId}")`;
    case "anchor_repair":
      return "anchor repair sweep";
    case "briefing_substitution":
      return `briefing substitution (source "${trigger.sourceId}")`;
  }
}

function itemInfo(item: SourceCaptureWorkItem): SourceCaptureItemInfo {
  return {
    workItemId: item.workItemId,
    origin: item.origin,
    label: item.label,
    ...(item.request.targetSourceId !== undefined
      ? { targetSourceId: item.request.targetSourceId }
      : {}),
  };
}

export interface AutoChainDependencies {
  runner?: JobRunner;
  startSourceExtraction?: typeof startSourceExtraction;
  startExistenceCheck?: typeof startExistenceCheck;
  startReferenceScan?: typeof startReferenceScan;
  buildAutoCaptureItems?: typeof buildAutoCaptureItems;
  startSourceCaptureItem?: typeof startSourceCaptureItem;
  // Automatic repair seams, injectable for tests (production resolves them
  // lazily — see the cycle rationale below).
  evaluateCaptureFailureRepair?: (
    projectId: string,
    workItemId: string,
  ) => Promise<void>;
  evaluateSourceRepair?: (projectId: string, sourceId: string) => Promise<void>;
  listRepairEvaluationSources?: (projectId: string) => Promise<string[]>;
  runFuzzyReanchorSweep?: (projectId: string) => Promise<unknown>;
  runBriefingSubstitution?: (
    projectId: string,
    sourceId: string,
  ) => Promise<unknown>;
}

export interface AutoChain {
  enqueueSourceExtraction(projectId: string, sourceId: string): void;
  enqueueExistenceCheck(projectId: string): void;
  enqueueReferenceScan(projectId: string): void;
  /** Queues one fuzzy re-anchor sweep (anchor auto-repair) — enqueued by
   * the briefing-revision publish action; extraction passes chain it
   * automatically. Coalesces with itself. */
  enqueueAnchorRepair(projectId: string): void;
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
 * cleanly", each capture one `source_capture` work item whose own per-source
 * extraction trigger (work-items/run-item.ts) rejoins the chain above. Both
 * chains share one queue per project, which is what keeps them off each
 * other's toes on the single-writer runner. Manual captures enter the very
 * same queue as work items (source work items) — the queue is the one
 * serialization point for every way a source comes into being.
 *
 * In-memory only, like the runner itself: a server restart drops whatever
 * was still queued. That is safe because nothing here is the durable truth —
 * claim statuses already record exactly what stage-1 still needs to see
 * (`captured` / `recheck_required`), the existence check re-derives its own
 * worklist from those statuses on every run, and a manual "re-extract this
 * source" action always exists as a human-triggered recovery. The reference
 * chain is drop-safe for the same reason: the scan and the capture both keep
 * their own manual buttons, and neither leaves half-written state behind.
 * A dropped capture work item loses only its queue slot — a failed ATTEMPT
 * is durable in the register, and re-enqueueing is one click.
 */
export function createAutoChain(deps: AutoChainDependencies = {}): AutoChain {
  const runner = deps.runner ?? getGlobalJobRunner();
  const runSourceExtraction =
    deps.startSourceExtraction ?? startSourceExtraction;
  const runExistenceCheck = deps.startExistenceCheck ?? startExistenceCheck;

  /**
   * The reference chain's two functions are resolved on first use rather
   * than imported at the top, for two reasons that happen to point the same
   * way.
   *
   * Correctness: `buildAutoCaptureItems` lives beside the candidate-capture
   * enqueue path, which imports `enqueueSourceCapture` from here — a static
   * import would close an import cycle where today there is none.
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

  let autoCaptureItems = deps.buildAutoCaptureItems;
  async function computeAutoCaptureItems(projectId: string) {
    autoCaptureItems ??= (
      await import("../sources/reference-scan/enqueue-candidate-capture")
    ).buildAutoCaptureItems;
    return autoCaptureItems(projectId);
  }

  // Lazily resolved for the same cycle reason as the reference chain above:
  // the capture item's step imports `enqueueSourceExtraction` from here (its
  // documented per-item chaining), so a static import would close a cycle.
  let sourceCaptureItem = deps.startSourceCaptureItem;
  async function runSourceCaptureItem(
    projectId: string,
    item: SourceCaptureWorkItem,
  ) {
    sourceCaptureItem ??= (await import("../sources/work-items/run-item"))
      .startSourceCaptureItem;
    return sourceCaptureItem(projectId, item, { runner });
  }

  // The automatic-repair steps, lazily resolved for the same reason: every
  // one of them enqueues onto this chain (their applied fixes are capture
  // work items) or is enqueued from modules that do.
  let captureFailureRepair = deps.evaluateCaptureFailureRepair;
  async function runCaptureFailureRepair(projectId: string, id: string) {
    captureFailureRepair ??= (
      await import("../sources/auto-repair/evaluate-capture-failure")
    ).evaluateCaptureFailureRepair;
    return captureFailureRepair(projectId, id);
  }
  let sourceRepair = deps.evaluateSourceRepair;
  async function runSourceRepairEvaluation(projectId: string, id: string) {
    sourceRepair ??= (await import("../sources/auto-repair/evaluate-source"))
      .evaluateSourceRepair;
    return sourceRepair(projectId, id);
  }
  let listRepairSources = deps.listRepairEvaluationSources;
  async function computeRepairEvaluationSources(
    projectId: string,
  ): Promise<string[]> {
    listRepairSources ??= (await import("../sources/auto-repair/candidates"))
      .sourcesNeedingRepairEvaluationForProject;
    try {
      return await listRepairSources(projectId);
    } catch {
      // Best-effort fan-out: a failed LISTING must never turn a completed
      // existence check into a warned failure — anything genuinely broken
      // resurfaces (and warns) in the evaluation triggers themselves.
      return [];
    }
  }
  let fuzzyReanchor = deps.runFuzzyReanchorSweep;
  async function runAnchorRepairSweep(projectId: string) {
    fuzzyReanchor ??= (await import("../repair/fuzzy-reanchor"))
      .runFuzzyReanchorSweep;
    return fuzzyReanchor(projectId);
  }
  let briefingSubstitution = deps.runBriefingSubstitution;
  async function runBriefingSubstitutionStep(projectId: string, id: string) {
    briefingSubstitution ??= (
      await import("../sources/auto-repair/briefing-substitution")
    ).runBriefingSubstitution;
    return briefingSubstitution(projectId, id);
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
      // Freshly created claims may carry the p0 sentinel anchor — one
      // fuzzy sweep behind the pass (anchor auto-repair; coalesces).
      queue.push({ kind: "anchor_repair" });
    } else if (trigger.kind === "reference_scan") {
      const handle = await runReferenceScan(projectId);
      await handle.done;
      // The automatic captures follow right behind the scan that computed
      // them, one work item each (source work items — the retired batch run
      // used to sit here). An empty list is the expected outcome of a
      // briefing whose citations all need a human, not an error.
      const items = await computeAutoCaptureItems(projectId);
      queue.unshift(
        ...items.map((item): PendingTrigger => ({
          kind: "source_capture",
          item,
        })),
      );
    } else if (trigger.kind === "source_capture") {
      activeCapture.set(projectId, itemInfo(trigger.item));
      let summary: { succeeded: number; failed: number } | undefined;
      try {
        const handle = await runSourceCaptureItem(projectId, trigger.item);
        summary = await handle.done;
      } finally {
        activeCapture.delete(projectId);
      }
      // Automatic repair fan-out: a failed reference-import capture gets
      // ONE automatic re-resolution attempt (the loop guard is the origin
      // — an auto_repair item's own failure never re-triggers); a
      // successful identity correction chains the mechanical briefing
      // substitution for its target.
      if (
        summary !== undefined &&
        summary.failed > 0 &&
        trigger.item.origin === "reference_import"
      ) {
        queue.push({
          kind: "capture_failure_repair",
          workItemId: trigger.item.workItemId,
        });
      }
      if (
        summary !== undefined &&
        summary.succeeded > 0 &&
        trigger.item.request.targetSourceId !== undefined
      ) {
        queue.push({
          kind: "briefing_substitution",
          sourceId: trigger.item.request.targetSourceId,
        });
      }
    } else if (trigger.kind === "capture_failure_repair") {
      await runCaptureFailureRepair(projectId, trigger.workItemId);
    } else if (trigger.kind === "source_repair_evaluation") {
      await runSourceRepairEvaluation(projectId, trigger.sourceId);
    } else if (trigger.kind === "anchor_repair") {
      await runAnchorRepairSweep(projectId);
    } else if (trigger.kind === "briefing_substitution") {
      await runBriefingSubstitutionStep(projectId, trigger.sourceId);
      // The substitution published a revision (or not) — either way the
      // sweep is cheap and coalesces; quotes may have shifted paragraphs.
      queue.push({ kind: "anchor_repair" });
    } else {
      const handle = await runExistenceCheck(projectId, { runner });
      await handle.done;
      // Sources whose wrong identity just stranded claims in adjudication
      // get one repair evaluation each (automatic repair; dedup per
      // source via sameTrigger).
      for (const sourceId of await computeRepairEvaluationSources(projectId)) {
        queue.push({ kind: "source_repair_evaluation", sourceId });
      }
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
    enqueueAnchorRepair(projectId) {
      push(projectId, { kind: "anchor_repair" });
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
/** Anchored on `globalThis` like the runner it queues onto: the page reads
 * the waiting backlog through `pendingCaptureItems`, the actions push onto
 * it, and a per-module-graph variable would let those be two queues. Exported
 * for the process-global test only — the app layer uses the bound functions
 * below, tests build their own chain with createAutoChain. */
export function getGlobalAutoChain(): AutoChain {
  return processGlobal("runs/auto-chain", createAutoChain);
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

/** Queues one fuzzy re-anchor sweep (anchor auto-repair) — the publish
 * action calls this after a briefing revision, so quotes that shifted
 * beyond the exact remap's reach get their bounded fuzzy attempt. */
export function enqueueAnchorRepair(projectId: string): void {
  getGlobalAutoChain().enqueueAnchorRepair(projectId);
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
