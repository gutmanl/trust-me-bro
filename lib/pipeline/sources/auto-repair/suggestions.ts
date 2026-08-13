import { randomUUID } from "node:crypto";

import { getCurrentActor } from "../../../identity";
import type { ClaimsRegister } from "../../../register";
import type {
  RepairAction,
  RepairActionTarget,
} from "../../../register/schema/history";
import { PipelineError, SourceCorrectionPreconditionError } from "../../errors";
import { requireProjectStore } from "../../projects";
import {
  activeCaptureItem,
  enqueueSourceCapture,
  pendingCaptureItems,
} from "../../runs/auto-chain";
import type { AutoChain } from "../../runs/auto-chain";
import { deriveOpenCaptureFailures } from "../work-items/failures";
import type { SourceCaptureWorkItem } from "../work-items/types";

/** One open repair suggestion or applied-repair audit row, app-facing. */
export interface RepairActionVM {
  target:
    | { kind: "capture_failure"; workItemId: string }
    | { kind: "source"; sourceId: string };
  mode: "suggested" | "applied";
  basis: RepairAction["basis"];
  candidate: {
    kind: "doi" | "arxiv" | "url";
    identifier?: string;
    documentUrl?: string;
    title?: string;
  };
  confidence?: number;
  quoteFit?: {
    candidateMatches: number;
    currentMatches: number;
    checkedExcerpts: number;
  };
  /** German explanation, straight from the event — never re-derived. */
  reason: string;
  recordedAt: string;
}

const targetKey = (target: RepairActionTarget): string =>
  target.kind === "capture_failure"
    ? `wi:${target.work_item_id}`
    : `src:${target.source_id}`;

/**
 * The still-open repair SUGGESTIONS of a register (automatic repair):
 * latest `source_repair_action` per target, in chain order — superseded by
 * a later dismissal (`source_repair_action_dismissed` naming the target's
 * scalar), by an applied action on the same target, by a manual/automatic
 * identity correction of a targeted source, by the dismissal of a targeted
 * capture failure, or by that failure's structural resolution (a source
 * claiming its work-item id). Applied actions never appear here — they are
 * audit trail, visible via the timeline. Pure register derivation.
 */
export function deriveOpenRepairActions(
  register: ClaimsRegister,
): RepairActionVM[] {
  const resolvedWorkItems = new Set(
    register.sources.flatMap((source) =>
      source.custom.capture_attempt_id !== undefined
        ? [source.custom.capture_attempt_id]
        : [],
    ),
  );
  const open = new Map<string, RepairActionVM>();
  for (const event of register.project_events) {
    if (event.event === "source_repair_action_dismissed") {
      if (event.work_item_id !== undefined) {
        open.delete(`wi:${event.work_item_id}`);
      }
      if (event.source_id !== undefined) {
        open.delete(`src:${event.source_id}`);
      }
      continue;
    }
    if (
      event.event === "source_capture_dismissed" &&
      event.work_item_id !== undefined
    ) {
      // The failure the suggestion was attached to is gone from view — the
      // suggestion goes with it.
      open.delete(`wi:${event.work_item_id}`);
      continue;
    }
    if (
      event.event === "source_identity_corrected" &&
      event.identity_change !== undefined
    ) {
      open.delete(`src:${event.identity_change.source_id}`);
      continue;
    }
    const action = event.repair_action;
    if (event.event !== "source_repair_action" || action === undefined) {
      continue;
    }
    const key = targetKey(action.target);
    if (action.mode === "applied") {
      // An automatic application supersedes any older suggestion for the
      // same target; the applied row itself is audit-only.
      open.delete(key);
      continue;
    }
    open.set(key, {
      target:
        action.target.kind === "capture_failure"
          ? { kind: "capture_failure", workItemId: action.target.work_item_id }
          : { kind: "source", sourceId: action.target.source_id },
      mode: action.mode,
      basis: action.basis,
      candidate: {
        kind: action.candidate.kind,
        ...(action.candidate.identifier !== undefined
          ? { identifier: action.candidate.identifier }
          : {}),
        ...(action.candidate.document_url !== undefined
          ? { documentUrl: action.candidate.document_url }
          : {}),
        ...(action.candidate.title !== undefined
          ? { title: action.candidate.title }
          : {}),
      },
      ...(action.confidence !== undefined
        ? { confidence: action.confidence }
        : {}),
      ...(action.quote_fit !== undefined
        ? {
            quoteFit: {
              candidateMatches: action.quote_fit.candidate_matches,
              currentMatches: action.quote_fit.current_matches,
              checkedExcerpts: action.quote_fit.checked_excerpts,
            },
          }
        : {}),
      reason: event.reason,
      recordedAt: event.at,
    });
  }
  // A capture-failure suggestion whose failure a source already resolved
  // is moot regardless of chain position (set-based, like the failure
  // derivation itself).
  return [...open.values()].filter(
    (entry) =>
      entry.target.kind !== "capture_failure" ||
      !resolvedWorkItems.has(entry.target.workItemId),
  );
}

function requireOpenSuggestion(
  register: ClaimsRegister,
  target: RepairActionVM["target"],
): RepairActionVM {
  const found = deriveOpenRepairActions(register).find((entry) =>
    entry.target.kind === "capture_failure" && target.kind === "capture_failure"
      ? entry.target.workItemId === target.workItemId
      : entry.target.kind === "source" &&
        target.kind === "source" &&
        entry.target.sourceId === target.sourceId,
  );
  if (!found) {
    throw new PipelineError(
      "Zu diesem Ziel liegt kein offener Reparaturvorschlag vor.",
    );
  }
  return found;
}

const dismissalScalars = (
  target: RepairActionVM["target"],
): { work_item_id?: string; source_id?: string } =>
  target.kind === "capture_failure"
    ? { work_item_id: target.workItemId }
    : { source_id: target.sourceId };

/**
 * Dismisses an open repair suggestion (automatic repair): the human
 * judgment "this derived candidate is not it", recorded under the human's
 * own actor — the suggestion disappears, the chain keeps it.
 */
export async function dismissRepairAction(
  projectId: string,
  target: RepairActionVM["target"],
): Promise<void> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  requireOpenSuggestion(register, target);
  await store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "source_repair_action_dismissed",
      reason: "Reparaturvorschlag verworfen.",
      actor: getCurrentActor(),
      ...dismissalScalars(target),
    });
  });
}

/**
 * Applies an open repair suggestion with one click (automatic repair):
 * builds the capture/correction work item from the suggestion's candidate,
 * consumes the suggestion (a dismissal event, so it cannot be
 * double-applied), and enqueues the attempt under origin "auto_repair" —
 * a human confirming an auto-derived candidate is still auto-repair
 * provenance, distinct from a hand-typed correction.
 */
export async function applySuggestedRepair(
  projectId: string,
  target: RepairActionVM["target"],
  deps: {
    chain?: Pick<
      AutoChain,
      "enqueueSourceCapture" | "pendingCaptureItems" | "activeCaptureItem"
    >;
  } = {},
): Promise<{ workItemId: string }> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const suggestion = requireOpenSuggestion(register, target);
  const candidate = suggestion.candidate;

  let item: SourceCaptureWorkItem;
  if (target.kind === "capture_failure") {
    const failure = deriveOpenCaptureFailures(register).find(
      (entry) => entry.workItemId === target.workItemId,
    );
    if (!failure) {
      throw new PipelineError(
        `Zum Arbeitsposten "${target.workItemId}" liegt kein offener ` +
          "Fehlschlag mehr vor.",
      );
    }
    item = {
      workItemId: target.workItemId,
      origin: "auto_repair",
      label: candidate.title ?? candidate.identifier ?? candidate.kind,
      request: {
        kind: candidate.kind,
        sourceType: failure.input.source_type,
        ...(candidate.identifier !== undefined
          ? { identifier: candidate.identifier }
          : {}),
        ...(candidate.documentUrl !== undefined
          ? { documentUrl: candidate.documentUrl }
          : {}),
        ...(failure.input.auto_capture !== undefined
          ? {
              autoCapture: {
                raw_text: failure.input.auto_capture.raw_text,
                method: "crossref_title",
                ...(suggestion.confidence !== undefined
                  ? { score: suggestion.confidence }
                  : {}),
              },
            }
          : {}),
      },
    };
  } else {
    const source = register.sources.find(
      (entry) => entry.id === target.sourceId,
    );
    if (!source) {
      throw new PipelineError(
        `Quelle "${target.sourceId}" existiert nicht mehr.`,
      );
    }
    const active = (deps.chain?.activeCaptureItem ?? activeCaptureItem)(
      projectId,
    );
    const queued = (deps.chain?.pendingCaptureItems ?? pendingCaptureItems)(
      projectId,
    );
    if (
      [active, ...queued].some(
        (entry) =>
          entry !== undefined && entry.targetSourceId === target.sourceId,
      )
    ) {
      throw new SourceCorrectionPreconditionError(
        `Für Quelle "${target.sourceId}" läuft bereits eine Korrektur – ` +
          "bitte deren Abschluss abwarten.",
      );
    }
    item = {
      workItemId: `wi_${randomUUID()}`,
      origin: "auto_repair",
      label: candidate.title ?? candidate.identifier ?? candidate.kind,
      request: {
        kind: candidate.kind,
        sourceType: source.custom.source_type,
        targetSourceId: target.sourceId,
        ...(candidate.identifier !== undefined
          ? { identifier: candidate.identifier }
          : {}),
        ...(candidate.documentUrl !== undefined
          ? { documentUrl: candidate.documentUrl }
          : {}),
      },
    };
  }

  // Consume first (durable), then enqueue (volatile): a crash between the
  // two loses only the queued attempt — re-derivable — never double-applies.
  await store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "source_repair_action_dismissed",
      reason: "Reparaturvorschlag übernommen und eingereiht.",
      actor: getCurrentActor(),
      ...dismissalScalars(target),
    });
  });
  (deps.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(projectId, item);
  return { workItemId: item.workItemId };
}
