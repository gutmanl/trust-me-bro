"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import {
  discardBriefingDraft,
  publishBriefingRevision,
  saveBriefingDraft,
  startSourceExtraction,
  startUnevidencedExtraction,
  startVerification,
} from "@/lib/pipeline";

/**
 * Server actions of the unified workbench. Everything the page mutates goes
 * through here, and every one of them revalidates the SAME path — the
 * workbench IS the project page now, so there is no per-step route left to
 * target.
 *
 * Source capture and revision deliberately keep living in
 * `../sources/actions.ts` beside the forms that are their only callers: they
 * already enqueue the auto-chain after a durable success, and duplicating
 * them here would mean two call sites racing to enqueue the same follow-up
 * pass.
 */

/** Every action below re-renders the workbench, nothing else. */
function revalidateWorkbench(projectId: string): void {
  revalidatePath(`/projects/${projectId}`);
}

export interface DraftSaveState {
  error: string | null;
  savedAt?: string;
}

/**
 * Stores the briefing editor's current text as the project's draft. Called
 * directly (debounced) from the editor rather than through a form, and
 * deliberately WITHOUT revalidation: the draft is scratch state outside the
 * register, and re-rendering the server tree on every keystroke pause would
 * fight the textarea the user is typing in.
 */
export async function saveBriefingDraftAction(
  projectId: string,
  text: string,
): Promise<DraftSaveState> {
  const result = await runPipelineAction(() =>
    saveBriefingDraft(projectId, text),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  return { error: null, savedAt: result.value.saved_at };
}

export interface BriefingFormState {
  error: string | null;
  published?: boolean;
  discarded?: boolean;
}

/**
 * Publishes the editor's text as the briefing's next revision — or, for a
 * project without a briefing yet, as the initial import (the pipeline
 * use-case decides, and requires the tool name only on that path).
 */
export async function publishBriefingRevisionAction(
  projectId: string,
  _previous: BriefingFormState,
  formData: FormData,
): Promise<BriefingFormState> {
  const text = String(formData.get("text") ?? "");
  const tool = String(formData.get("tool") ?? "").trim();
  const result = await runPipelineAction(() =>
    publishBriefingRevision(projectId, {
      text,
      ...(tool.length > 0 ? { tool } : {}),
    }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidateWorkbench(projectId);
  return { error: null, published: true };
}

/** Throws the draft away; the frozen briefing is untouched by it anyway. */
export async function discardBriefingDraftAction(
  projectId: string,
  _previous: BriefingFormState,
  _formData: FormData,
): Promise<BriefingFormState> {
  const result = await runPipelineAction(() => discardBriefingDraft(projectId));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidateWorkbench(projectId);
  return { error: null, discarded: true };
}

/** Run starts report only failure: whether a run is live is answered by the
 * shared project event stream, not by a stale action result. A `started`
 * flag here would go stale the moment the run ends and could not be told
 * apart from "still running" without a second latch. */
export interface RunFormState {
  error: string | null;
}

/** The sweep for claims citing no captured source — the one extraction pass
 * that belongs to no single source (the per-source passes auto-chain from a
 * capture, or are re-run from the source's own row). */
export async function startUnevidencedExtractionAction(
  projectId: string,
  _previous: RunFormState,
  _formData: FormData,
): Promise<RunFormState> {
  const result = await runPipelineAction(() =>
    startUnevidencedExtraction(projectId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidateWorkbench(projectId);
  return { error: null };
}

/** Re-runs the extraction pass for one source — the manual counterpart of
 * the pass the auto-chain starts after a capture (a revised source, or a
 * pass that failed, needs one without re-capturing). */
export async function startSourceExtractionAction(
  projectId: string,
  sourceId: string,
  _previous: RunFormState,
  _formData: FormData,
): Promise<RunFormState> {
  const result = await runPipelineAction(() =>
    startSourceExtraction(projectId, sourceId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidateWorkbench(projectId);
  return { error: null };
}

/** Stages 2 and 3 (attribution + calibration) over the open claims. */
export async function startVerificationAction(
  projectId: string,
  _previous: RunFormState,
  _formData: FormData,
): Promise<RunFormState> {
  const result = await runPipelineAction(() => startVerification(projectId));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidateWorkbench(projectId);
  return { error: null };
}
