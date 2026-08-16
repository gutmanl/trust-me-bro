import type { ProjectEvent, TriggerKind } from "../../register";
import { runKindLabel } from "./labels";
import { AUTO_CHAIN_ACTOR } from "./trigger-brackets";

/**
 * Read-time derivation of the auto-chain's unclosed brackets (run
 * visibility) — the durable half of "nothing that blocks may be invisible".
 *
 * Nobody closes a stale bracket proactively, and that is the point
 * (verification's interrupted-derivation precedent): a bracket left open by
 * a crash, a cancel or an expired deadline looks identical on the chain — a
 * `batch_run_started` whose (kind, target) never saw a later completion —
 * and this derivation reads all three as "interrupted", recomputed on every
 * read. If an abandoned trigger's zombie later settles and writes its
 * natural close, the same read self-heals with zero reconciliation code.
 *
 * Per-TARGET matching, unlike verification's single project-wide bracket:
 * evaluator brackets for different sources/work items interleave over the
 * project's life, so a start is closed only by a later completion carrying
 * the same kind AND the same target scalar.
 */
export interface OpenChainTrigger {
  kind: TriggerKind;
  /** German, computed here so no client ever has to render the raw enum
   * token — the display tier never leaks internal vocabulary. */
  description: string;
  sourceId?: string;
  workItemId?: string;
  since: string;
}

function targetOf(event: ProjectEvent): string {
  // Work-item id first: capture brackets carry both scalars (the correction
  // case), and the work item is the attempt's identity.
  return event.work_item_id ?? event.source_id ?? "";
}

export function deriveOpenChainTriggers(
  events: readonly ProjectEvent[],
): OpenChainTrigger[] {
  const open = new Map<string, OpenChainTrigger>();
  for (const event of events) {
    if (event.actor !== AUTO_CHAIN_ACTOR || event.trigger_kind === undefined) {
      continue;
    }
    const key = `${event.trigger_kind}\n${targetOf(event)}`;
    if (event.event === "batch_run_started") {
      open.set(key, {
        kind: event.trigger_kind,
        description: runKindLabel(event.trigger_kind),
        ...(event.source_id !== undefined ? { sourceId: event.source_id } : {}),
        ...(event.work_item_id !== undefined
          ? { workItemId: event.work_item_id }
          : {}),
        since: event.at,
      });
    } else if (event.event === "batch_run_completed") {
      open.delete(key);
    }
  }
  return [...open.values()];
}
