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
  origin: "manual" | "reference_import";
  reason: string;
  failedAt: string;
  input: CaptureFailureInput;
}

/**
 * The still-open capture failures of a register: the LATEST
 * `source_capture_failed` event per work item (append order decides), minus
 * every work item some source's `custom.capture_attempt_id` already claims —
 * a successful retry resolves its failure by existing, no "resolved" event
 * needed. Pure register derivation; the caller overlays the volatile
 * queued/running state, which takes precedence in display.
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
  const latest = new Map<string, CaptureFailureVM>();
  for (const event of register.project_events) {
    const failure = event.capture_failure;
    if (event.event !== "source_capture_failed" || failure === undefined) {
      continue;
    }
    if (resolved.has(failure.work_item_id)) {
      continue;
    }
    latest.set(failure.work_item_id, {
      workItemId: failure.work_item_id,
      origin: failure.origin,
      reason: event.reason,
      failedAt: event.at,
      input: failure.input,
    });
  }
  return [...latest.values()];
}
