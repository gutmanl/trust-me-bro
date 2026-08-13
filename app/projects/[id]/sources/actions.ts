"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import {
  enqueueExistenceCheck,
  enqueueManualCapture,
  retryManualCapture,
  reviseSource,
} from "@/lib/pipeline";
import type { CaptureKind, ManualCaptureInput } from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";
import { SOURCE_TYPE_LABELS } from "../../status-labels";

export interface SourceFormState {
  error: string | null;
  /** Work-item id of the queued capture, set after a successful submit —
   * the modal closes on it; the row's progress arrives via the stream. */
  queued?: string;
}

// Derived from the one house label map, like the dropdowns it validates.
const SOURCE_TYPES = Object.keys(SOURCE_TYPE_LABELS) as SourceType[];

const CAPTURE_KINDS: CaptureKind[] = ["doi", "arxiv", "url", "upload"];

function optional(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Queues a manual source capture as a work item (source work items): the
 * action only parses the form and enqueues — network, PDF check and
 * freezing happen in the item's own run, whose per-item status the sources
 * list shows live. Chaining the extraction pass lives inside the item's
 * step now, not here.
 */
export async function enqueueCaptureSourceAction(
  projectId: string,
  _previous: SourceFormState,
  formData: FormData,
): Promise<SourceFormState> {
  const kind = String(formData.get("kind") ?? "");
  const sourceType = String(formData.get("source_type") ?? "");
  if (!CAPTURE_KINDS.includes(kind as CaptureKind)) {
    return { error: "Unbekannte Erfassungsart." };
  }
  if (!SOURCE_TYPES.includes(sourceType as SourceType)) {
    return { error: "Bitte einen Quellentyp wählen." };
  }

  const input: ManualCaptureInput = {
    kind: kind as CaptureKind,
    sourceType: sourceType as SourceType,
  };
  const identifier = optional(formData.get("identifier"));
  if (identifier !== undefined) {
    input.identifier = identifier;
  }
  const documentUrl = optional(formData.get("document_url"));
  if (documentUrl !== undefined) {
    input.documentUrl = documentUrl;
  }

  const title = optional(formData.get("title"));
  if (title) {
    input.manual = {
      title,
      authors: optional(formData.get("authors")),
      year: optional(formData.get("year")),
      container_title: optional(formData.get("container_title")),
    };
  }

  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    input.upload = {
      content: Buffer.from(await file.arrayBuffer()),
      filename: file.name,
    };
  }

  const result = await runPipelineAction(() =>
    enqueueManualCapture(projectId, input),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null, queued: result.value.workItemId };
}

export interface RetryCaptureState {
  error: string | null;
}

/** One-click retry of a failed capture work item, from its durable input
 * snapshot — no re-upload, no modal. */
export async function retryCaptureAction(
  projectId: string,
  workItemId: string,
  _previous: RetryCaptureState,
): Promise<RetryCaptureState> {
  const result = await runPipelineAction(() =>
    retryManualCapture(projectId, workItemId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null };
}

export interface ReviseFormState {
  error: string | null;
  /** Set after a successful submit: whether a new revision was created. */
  revised?: boolean;
  newRevision?: number;
  recheckedCount?: number;
}

export async function reviseSourceAction(
  projectId: string,
  sourceId: string,
  _previous: ReviseFormState,
  formData: FormData,
): Promise<ReviseFormState> {
  const input = {
    projectId,
    sourceId,
    documentUrl: optional(formData.get("document_url")),
    upload: undefined as { content: Buffer; filename: string } | undefined,
  };
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    input.upload = {
      content: Buffer.from(await file.arrayBuffer()),
      filename: file.name,
    };
  }
  const result = await runPipelineAction(() => reviseSource(input));
  if (result.error !== null) {
    return { error: result.error };
  }
  // A revision pulls affected claims back to recheck_required — auto-chain
  // an existence check so they don't sit unchecked until someone notices.
  enqueueExistenceCheck(projectId);
  revalidatePath(`/projects/${projectId}`);
  return {
    error: null,
    revised: result.value.revised,
    newRevision: result.value.newRevision,
    recheckedCount: result.value.recheckedClaimIds.length,
  };
}
