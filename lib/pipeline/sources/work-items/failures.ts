import { getCurrentActor } from "../../../identity";
import type { ClaimsRegister } from "../../../register";
import type { CaptureFailureInput } from "../../../register/schema/history";
import { PipelineError } from "../../errors";
import { requireProjectStore } from "../../projects";
import type { SourceCaptureRequest, SourceCaptureWorkItem } from "./types";

/** Actor of every asynchronous capture attempt's register writes: the
 * attempt runs detached from the submitting request, like the other
 * system actors of run-bound work. */
export const CAPTURE_ACTOR = "system:capture";

/** The durable, retryable snapshot of a request — buffers never enter the
 * register; an upload is already a blob reference by construction. */
export function captureFailureInputOf(
  request: SourceCaptureRequest,
): CaptureFailureInput {
  return {
    kind: request.kind,
    source_type: request.sourceType,
    ...(request.targetSourceId !== undefined
      ? { target_source_id: request.targetSourceId }
      : {}),
    ...(request.identifier !== undefined
      ? { identifier: request.identifier }
      : {}),
    ...(request.documentUrl !== undefined
      ? { document_url: request.documentUrl }
      : {}),
    ...(request.manual !== undefined
      ? {
          manual: {
            title: request.manual.title,
            ...(request.manual.authors !== undefined
              ? { authors: request.manual.authors }
              : {}),
            ...(request.manual.year !== undefined
              ? { year: request.manual.year }
              : {}),
            ...(request.manual.container_title !== undefined
              ? { container_title: request.manual.container_title }
              : {}),
          },
        }
      : {}),
    ...(request.uploadBlob !== undefined
      ? { upload: { ...request.uploadBlob } }
      : {}),
    ...(request.autoCapture !== undefined
      ? { auto_capture: { ...request.autoCapture } }
      : {}),
  };
}

/**
 * Records one failed capture attempt durably (source work items): the
 * volatile run log answers "what just happened", this event answers "why is
 * this source still missing" — across reloads and restarts. Called from the
 * capture item's step AFTER the impure work already failed; the write is a
 * transaction of its own, per the house rule.
 */
export async function recordCaptureFailure(
  projectId: string,
  item: SourceCaptureWorkItem,
  error: unknown,
): Promise<void> {
  const store = requireProjectStore(projectId);
  const message =
    error instanceof PipelineError
      ? error.message
      : `Erfassung fehlgeschlagen: ${
          error instanceof Error ? error.message : String(error)
        }`;
  await store.transaction((tx) => {
    tx.recordCaptureFailure({
      work_item_id: item.workItemId,
      origin: item.origin,
      input: captureFailureInputOf(item.request),
      actor: CAPTURE_ACTOR,
      reason: message,
    });
  });
}

/** One unresolved durable capture failure, ready for display and retry. */
export interface CaptureFailureVM {
  workItemId: string;
  origin: "manual" | "reference_import" | "correction" | "auto_repair";
  reason: string;
  failedAt: string;
  input: CaptureFailureInput;
}

/**
 * The still-open capture failures of a register: the LATEST
 * `source_capture_failed` event per work item (append order decides), minus
 * every work item some source's `custom.capture_attempt_id` already claims —
 * a successful retry resolves its failure by existing, no "resolved" event
 * needed — and minus every failure a later `source_capture_dismissed`
 * event waved off. A correction failure (source correction) is instead
 * resolved by a later `source_identity_corrected` event of its TARGET
 * source: any successful correction of that source supersedes every prior
 * failed attempt on it, whatever its work-item id. Chain order carries the
 * semantics throughout: a dismissal/correction only covers the failures
 * BEFORE it, so a fresh failure reopens the entry. Pure register
 * derivation; the caller overlays the volatile queued/running state, which
 * takes precedence in display.
 */
export function deriveOpenCaptureFailures(
  register: ClaimsRegister,
): CaptureFailureVM[] {
  const resolved = new Set(
    register.sources.flatMap((source) =>
      source.custom.capture_attempt_id !== undefined
        ? [source.custom.capture_attempt_id]
        : [],
    ),
  );
  const open = new Map<string, CaptureFailureVM>();
  for (const event of register.project_events) {
    if (
      event.event === "source_capture_dismissed" &&
      event.work_item_id !== undefined
    ) {
      open.delete(event.work_item_id);
      continue;
    }
    if (
      event.event === "source_identity_corrected" &&
      event.identity_change !== undefined
    ) {
      const correctedSourceId = event.identity_change.source_id;
      for (const [workItemId, entry] of open) {
        if (entry.input.target_source_id === correctedSourceId) {
          open.delete(workItemId);
        }
      }
      continue;
    }
    const failure = event.capture_failure;
    if (event.event !== "source_capture_failed" || failure === undefined) {
      continue;
    }
    if (resolved.has(failure.work_item_id)) {
      continue;
    }
    open.set(failure.work_item_id, {
      workItemId: failure.work_item_id,
      origin: failure.origin,
      reason: event.reason,
      failedAt: event.at,
      input: failure.input,
    });
  }
  return [...open.values()];
}

/**
 * Dismisses a work item's open capture failure (source work items): appends
 * a `source_capture_dismissed` event that hides the failure row without
 * erasing anything from the chain — the human judgment "this attempt is not
 * worth keeping in view", recorded under the human's own actor. The one
 * resolution path for failures that can never succeed by retry, like a
 * reference-import item whose candidate left the scan result.
 */
export async function dismissCaptureFailure(
  projectId: string,
  workItemId: string,
): Promise<void> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const failure = deriveOpenCaptureFailures(register).find(
    (candidate) => candidate.workItemId === workItemId,
  );
  if (!failure) {
    throw new PipelineError(
      `Zum Arbeitsposten "${workItemId}" liegt kein offener Fehlschlag vor.`,
    );
  }
  await store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "source_capture_dismissed",
      reason: `Fehlgeschlagener Erfassungsversuch verworfen: ${failure.reason}`,
      actor: getCurrentActor(),
      work_item_id: workItemId,
    });
  });
}
