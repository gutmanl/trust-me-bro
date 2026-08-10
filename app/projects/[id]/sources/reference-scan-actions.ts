"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import {
  setUnpaywallEmail,
  startReferenceCapture,
  startReferenceScan,
} from "@/lib/pipeline";

import { parseCaptureSelections } from "./parse-capture-selections";

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
  revalidatePath(`/projects/${projectId}/sources`);
  return { error: null, started: true };
}

export interface ReferenceCaptureFormState {
  error: string | null;
  started?: boolean;
}

export async function startReferenceCaptureAction(
  projectId: string,
  _previous: ReferenceCaptureFormState,
  formData: FormData,
): Promise<ReferenceCaptureFormState> {
  const selections = parseCaptureSelections(formData);
  const result = await runPipelineAction(() =>
    startReferenceCapture(projectId, selections),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/sources`);
  return { error: null, started: true };
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
  revalidatePath(`/projects/${projectId}/sources`);
  return { error: null };
}
