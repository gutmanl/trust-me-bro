"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import {
  dismissCaptureFailure,
  enqueueExistenceCheck,
  enqueueManualCapture,
  enqueueSourceCorrection,
  retryManualCapture,
  reviseSource,
} from "@/lib/pipeline";
import type {
  CaptureKind,
  ManualCaptureInput,
  SourceCorrectionInput,
} from "@/lib/pipeline";
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

/** The uploaded document of a form submit, if one was chosen — shared by
 * every action that accepts a file. */
async function parseUploadFile(
  formData: FormData,
): Promise<{ content: Buffer; filename: string } | undefined> {
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    return {
      content: Buffer.from(await file.arrayBuffer()),
      filename: file.name,
    };
  }
  return undefined;
}

/** The identity half both the capture modal and the correction form submit:
 * identifier, document URL, manual metadata and the uploaded file — one
 * parser, so the two forms can never drift apart. */
async function parseIdentityFormData(
  formData: FormData,
): Promise<Omit<ManualCaptureInput, "kind" | "sourceType">> {
  const input: Omit<ManualCaptureInput, "kind" | "sourceType"> = {};
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
  const upload = await parseUploadFile(formData);
  if (upload !== undefined) {
    input.upload = upload;
  }
  return input;
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
    ...(await parseIdentityFormData(formData)),
  };

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

/** Dismisses a failed capture work item's row (source work items): appends
 * the durable dismissal event — the failure stays in the chain, only the
 * row disappears. */
export async function dismissCaptureAction(
  projectId: string,
  workItemId: string,
  _previous: RetryCaptureState,
): Promise<RetryCaptureState> {
  const result = await runPipelineAction(() =>
    dismissCaptureFailure(projectId, workItemId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null };
}

export interface CorrectSourceFormState {
  error: string | null;
  /** Document mode, after a successful submit: whether a new revision was
   * created (false = checksum-identical no-op). */
  revised?: boolean;
  newRevision?: number;
  recheckedCount?: number;
  /** Identity mode: work-item id of the queued correction — the modal
   * closes on it; progress arrives through the source row's live state. */
  queuedCorrection?: string;
}

/**
 * The combined "Quelle korrigieren" action: document mode re-freezes the
 * current document synchronously (TMB-44 revision, unchanged semantics);
 * identity mode queues an asynchronous identity correction work item
 * (source correction) whose per-source status the row shows live.
 */
export async function correctSourceAction(
  projectId: string,
  sourceId: string,
  _previous: CorrectSourceFormState,
  formData: FormData,
): Promise<CorrectSourceFormState> {
  const mode = String(formData.get("mode") ?? "document");

  if (mode === "identity") {
    const kind = String(formData.get("kind") ?? "");
    if (!CAPTURE_KINDS.includes(kind as CaptureKind)) {
      return { error: "Unbekannte Erfassungsart." };
    }
    const sourceType = optional(formData.get("source_type"));
    if (
      sourceType !== undefined &&
      !SOURCE_TYPES.includes(sourceType as SourceType)
    ) {
      return { error: "Bitte einen Quellentyp wählen." };
    }
    const input: SourceCorrectionInput = {
      kind: kind as CaptureKind,
      ...(sourceType !== undefined
        ? { sourceType: sourceType as SourceType }
        : {}),
      ...(await parseIdentityFormData(formData)),
    };
    const result = await runPipelineAction(() =>
      enqueueSourceCorrection(projectId, sourceId, input),
    );
    if (result.error !== null) {
      return { error: result.error };
    }
    revalidatePath(`/projects/${projectId}`);
    return { error: null, queuedCorrection: result.value.workItemId };
  }

  const input = {
    projectId,
    sourceId,
    documentUrl: optional(formData.get("document_url")),
    upload: await parseUploadFile(formData),
  };
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
