"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import {
  applySuggestedRepair,
  correctSourceMetadata,
  deriveMetadataFromDocument,
  dismissCaptureFailure,
  dismissRepairAction,
  enqueueExistenceCheck,
  enqueueManualCapture,
  enqueueSourceCorrection,
  removeQueuedCapture,
  retryInterruptedCapture,
  retryManualCapture,
  revertSourceIdentity,
  reviseSource,
} from "@/lib/pipeline";
import type {
  CaptureKind,
  DerivedMetadataCandidate,
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

/** Serializable repair-suggestion target for the two suggestion actions
 * (automatic repair): kind + id instead of the discriminated object, so it
 * binds cleanly into a server action. */
export type RepairTargetKind = "capture_failure" | "source";

function repairTarget(
  kind: RepairTargetKind,
  id: string,
): Parameters<typeof applySuggestedRepair>[1] {
  return kind === "capture_failure"
    ? { kind, workItemId: id }
    : { kind, sourceId: id };
}

/** One-click apply of an open repair suggestion (automatic repair): the
 * derived candidate is enqueued as an auto_repair work item and the
 * suggestion is consumed. */
export async function applyRepairSuggestionAction(
  projectId: string,
  targetKind: RepairTargetKind,
  targetId: string,
  _previous: RetryCaptureState,
): Promise<RetryCaptureState> {
  const result = await runPipelineAction(() =>
    applySuggestedRepair(projectId, repairTarget(targetKind, targetId)),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null };
}

/** Dismisses an open repair suggestion (automatic repair): durable event,
 * the chain keeps the derived candidate. */
export async function dismissRepairSuggestionAction(
  projectId: string,
  targetKind: RepairTargetKind,
  targetId: string,
  _previous: RetryCaptureState,
): Promise<RetryCaptureState> {
  const result = await runPipelineAction(() =>
    dismissRepairAction(projectId, repairTarget(targetKind, targetId)),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null };
}

export interface DeriveMetadataFormState {
  error: string | null;
  /** What the document says it is, for the confirm step to render. Absent
   * until a derivation has run. */
  candidate?: DerivedMetadataCandidate;
  /** The document URL the derivation actually used, echoed back.
   *
   * Needed because the confirm step is a DIFFERENT form body than the input
   * step: once the user falls back to typing the metadata by hand on the
   * "url" kind, `correctSource` still needs that URL as the kind's
   * identifier, and the input the user typed it into is no longer mounted.
   * Echoing it is cheaper and less fragile than mirroring the input into
   * component state.
   */
  documentUrl?: string;
}

/**
 * Reads a document and reports the bibliographic identity it states about
 * ITSELF (source correction, "both" mode).
 *
 * Writes NOTHING to the register — and therefore deliberately does not
 * revalidate: nothing on the page changed, and a revalidation would
 * re-render the whole project underneath an open modal for no reason.
 */
export async function deriveMetadataAction(
  projectId: string,
  _previous: DeriveMetadataFormState,
  formData: FormData,
): Promise<DeriveMetadataFormState> {
  const upload = await parseUploadFile(formData);
  // The "url" kind puts the document URL in `identifier`; the DOI kind has a
  // `document_url` field of its own. Only url/upload offer derivation, but
  // reading both keeps this honest if that ever widens.
  const documentUrl =
    optional(formData.get("document_url")) ??
    optional(formData.get("identifier"));
  const result = await runPipelineAction(() =>
    deriveMetadataFromDocument({
      projectId,
      ...(upload !== undefined ? { upload } : {}),
      ...(upload === undefined && documentUrl !== undefined
        ? { documentUrl }
        : {}),
    }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  return {
    error: null,
    candidate: result.value,
    ...(upload === undefined && documentUrl !== undefined
      ? { documentUrl }
      : {}),
  };
}

export interface CorrectSourceFormState {
  error: string | null;
  /** Document mode, after a successful submit: whether a new revision was
   * created (false = checksum-identical no-op). */
  revised?: boolean;
  newRevision?: number;
  recheckedCount?: number;
  /** Metadata mode, after a successful submit: the bibliographic core was
   * replaced and the frozen document left alone. The count of readmitted
   * claims rides on `recheckedCount`, shared with document mode. */
  metadataCorrected?: true;
  /** "Both" mode: work-item id of the queued correction — the modal closes
   * on it; progress arrives through the source row's live state. */
  queuedCorrection?: string;
}

/**
 * The combined "Quelle korrigieren" action, one per modal mode:
 *
 * - document — re-freezes the current document synchronously (TMB-44
 *   revision, unchanged semantics), identity untouched;
 * - metadata — replaces the bibliographic core synchronously and leaves the
 *   frozen document exactly as it is (source correction, metadata mode);
 * - both — queues an asynchronous identity correction work item whose
 *   per-source status the row shows live.
 */
export async function correctSourceAction(
  projectId: string,
  sourceId: string,
  _previous: CorrectSourceFormState,
  formData: FormData,
): Promise<CorrectSourceFormState> {
  const mode = String(formData.get("mode") ?? "document");

  if (mode === "metadata") {
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
    // Picked field by field from the shared parser, deliberately NOT spread
    // wholesale: CorrectSourceMetadataInput has no upload and no documentUrl
    // member, so a spread would be a type error — and that type error is the
    // design working. This mode must not carry a document even if a stray
    // field ever appears in the FormData.
    const identity = await parseIdentityFormData(formData);
    const result = await runPipelineAction(() =>
      correctSourceMetadata({
        projectId,
        sourceId,
        kind: kind as CaptureKind,
        ...(identity.identifier !== undefined
          ? { identifier: identity.identifier }
          : {}),
        ...(identity.manual !== undefined ? { manual: identity.manual } : {}),
        ...(sourceType !== undefined
          ? { sourceType: sourceType as SourceType }
          : {}),
      }),
    );
    if (result.error !== null) {
      return { error: result.error };
    }
    // Same gate as the document branch: only chain an existence check when
    // claims actually came back, or the trigger fans repair evaluation out
    // across the whole project for nothing.
    if (result.value.recheckedClaimIds.length > 0) {
      enqueueExistenceCheck(projectId);
    }
    revalidatePath(`/projects/${projectId}`);
    return {
      error: null,
      metadataCorrected: true,
      recheckedCount: result.value.recheckedClaimIds.length,
    };
  }

  if (mode === "both") {
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
    // The derive→confirm round trip (D-15): the confirm submit carries the
    // blob the derive step already froze, instead of the file again.
    //
    // TRUST BOUNDARY — this is where the untrusted value enters. The browser
    // sends back only a blob reference and, for doi/arxiv, the identifier
    // string; it never sends resolved CSL fields, because `correctSource`
    // re-resolves the identifier server-side and that re-resolution is what
    // makes the frozen identity trustworthy. The reference itself is
    // validated in `freezeUpload` (blobs().exists + filename shape), which
    // converts a malformed or absent path into a German
    // InvalidSourceInputError rather than an unhandled ENOENT.
    const uploadBlobPath = optional(formData.get("upload_blob_path"));
    const uploadFilename = optional(formData.get("upload_filename"));
    const input: SourceCorrectionInput = {
      kind: kind as CaptureKind,
      ...(sourceType !== undefined
        ? { sourceType: sourceType as SourceType }
        : {}),
      ...(await parseIdentityFormData(formData)),
      ...(uploadBlobPath !== undefined && uploadFilename !== undefined
        ? {
            uploadBlob: {
              blob_path: uploadBlobPath,
              filename: uploadFilename,
            },
          }
        : {}),
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
  // Only when it actually pulled some back, though: a checksum-identical
  // re-upload writes nothing at all, and an existence_check trigger fans
  // repair evaluation out across the WHOLE project through
  // runs/auto-chain.ts and sources/auto-repair/candidates.ts. That fan-out
  // is how a no-op re-upload produced a junk 37 %-confidence repair
  // suggestion in the live project. The queued correction path already
  // gates the same call this way in sources/work-items/run-item.ts.
  if (result.value.recheckedClaimIds.length > 0) {
    enqueueExistenceCheck(projectId);
  }
  // Unconditional by contrast: the form state changes either way, so the
  // page has to re-render even for the no-op.
  revalidatePath(`/projects/${projectId}`);
  return {
    error: null,
    revised: result.value.revised,
    newRevision: result.value.newRevision,
    recheckedCount: result.value.recheckedClaimIds.length,
  };
}

/**
 * Takes back the last identity correction of a source (source correction):
 * restores the archived bibliographic core, together with the document that
 * correction replaced — if it replaced one. The case it exists for is an
 * accepted repair suggestion that turned out to name a different work — the
 * source then carries both wrong metadata and a wrong frozen document, and
 * every claim citing it fails stage 1.
 */
export async function revertSourceIdentityAction(
  projectId: string,
  sourceId: string,
  _previous: RetryCaptureState,
): Promise<RetryCaptureState> {
  const result = await runPipelineAction(() =>
    revertSourceIdentity(projectId, sourceId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null };
}

/** Drops a still-waiting capture from the backlog (run visibility): queued
 * work must be removable. A stale click is a no-op, never an error. */
export async function removeQueuedCaptureAction(
  projectId: string,
  workItemId: string,
  _previous: RetryCaptureState,
): Promise<RetryCaptureState> {
  const result = await runPipelineAction(async () =>
    removeQueuedCapture(projectId, workItemId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null };
}

/** Re-queues an interrupted capture attempt from its start bracket's input
 * snapshot (run visibility) — the retry for the attempt that never even
 * recorded a failure. */
export async function retryInterruptedCaptureAction(
  projectId: string,
  workItemId: string,
  _previous: RetryCaptureState,
): Promise<RetryCaptureState> {
  const result = await runPipelineAction(() =>
    retryInterruptedCapture(projectId, workItemId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null };
}
