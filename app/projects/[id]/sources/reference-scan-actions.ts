"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import {
  enqueueCandidateCapture,
  enqueueReadyCandidateCaptures,
  setUnpaywallEmail,
  startReferenceScan,
} from "@/lib/pipeline";
import type { ReferenceCaptureSelection } from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";
import { SOURCE_TYPE_LABELS } from "../../status-labels";

export interface ReferenceScanFormState {
  error: string | null;
  started?: boolean;
}

export async function startReferenceScanAction(
  projectId: string,
  _previous: ReferenceScanFormState,
  _formData: FormData,
): Promise<ReferenceScanFormState> {
  const result = await runPipelineAction(() => startReferenceScan(projectId));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null, started: true };
}

export interface CandidateCaptureFormState {
  error: string | null;
  /** Work-item id of the queued capture, set after a successful submit. */
  queued?: string;
}

// Derived from the one house label map, like the dropdowns it validates.
const SOURCE_TYPES = Object.keys(SOURCE_TYPE_LABELS) as SourceType[];

function optional(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Queues ONE candidate as a capture work item (source work items) — each
 * candidate row is its own form now, so the fields carry no per-row name
 * suffixes and the old multi-row FormData parser is gone with the batch run.
 */
export async function captureCandidateAction(
  projectId: string,
  candidateId: string,
  _previous: CandidateCaptureFormState,
  formData: FormData,
): Promise<CandidateCaptureFormState> {
  const sourceType = String(formData.get("source_type") ?? "");
  if (!SOURCE_TYPES.includes(sourceType as SourceType)) {
    return { error: "Bitte einen Quellentyp wählen." };
  }
  const selection: ReferenceCaptureSelection = {
    candidateId,
    sourceType: sourceType as SourceType,
  };
  const title = optional(formData.get("title"));
  if (title !== undefined) {
    selection.title = title;
  }
  const documentUrl = optional(formData.get("document_url"));
  if (documentUrl !== undefined) {
    selection.documentUrl = documentUrl;
  }
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    selection.upload = {
      content: Buffer.from(await file.arrayBuffer()),
      filename: file.name,
    };
  }

  const result = await runPipelineAction(() =>
    enqueueCandidateCapture(projectId, selection),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null, queued: result.value.workItemId };
}

export interface ReadyCandidatesFormState {
  error: string | null;
  queued?: number;
}

/** "Alle offenen übernehmen": queues every candidate the review would
 * submit unmodified; rows needing completion stay behind. */
export async function captureReadyCandidatesAction(
  projectId: string,
  _previous: ReadyCandidatesFormState,
): Promise<ReadyCandidatesFormState> {
  const result = await runPipelineAction(() =>
    enqueueReadyCandidateCaptures(projectId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null, queued: result.value.queued };
}

export interface UnpaywallFormState {
  error: string | null;
}

/**
 * Sets or clears the installation-level Unpaywall address from the
 * reference-import panel (reference auto-import, Amendment 2). Not
 * project-scoped data, but the action lives beside the panel that is its
 * only caller; it revalidates the sources page so the panel re-renders with
 * the new setting active — saving never triggers a scan.
 */
export async function setUnpaywallEmailAction(
  projectId: string,
  _previous: UnpaywallFormState,
  formData: FormData,
): Promise<UnpaywallFormState> {
  const email = String(formData.get("unpaywall_email") ?? "").trim() || null;
  const result = await runPipelineAction(() => setUnpaywallEmail(email));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null };
}
