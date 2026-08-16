"use server";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { cancelActivity, cancelRun, pauseRun, resumeRun } from "@/lib/pipeline";

/**
 * Shared pause/resume/cancel actions of the multi-item run panels
 * (verification, relevance; TMB-50) — one implementation instead of a
 * per-feature triplet, mirroring the shared run-feed dedup rationale.
 */

export interface RunControlFormState {
  error: string | null;
}

export async function pauseRunAction(
  projectId: string,
  kind: string,
  _previous: RunControlFormState,
  _formData: FormData,
): Promise<RunControlFormState> {
  const result = await runPipelineAction(async () => pauseRun(projectId, kind));
  return { error: result.error };
}

export async function resumeRunAction(
  projectId: string,
  kind: string,
  _previous: RunControlFormState,
  _formData: FormData,
): Promise<RunControlFormState> {
  const result = await runPipelineAction(async () =>
    resumeRun(projectId, kind),
  );
  return { error: result.error };
}

export async function cancelRunAction(
  projectId: string,
  kind: string,
  _previous: RunControlFormState,
  _formData: FormData,
): Promise<RunControlFormState> {
  const result = await runPipelineAction(async () =>
    cancelRun(projectId, kind),
  );
  return { error: result.error };
}

/**
 * Cancels whatever currently occupies the project — a run or an off-runner
 * chain trigger — without the caller knowing which (run visibility): the
 * status bar's one cancel for the one activity it shows.
 */
export async function cancelActivityAction(
  projectId: string,
  _previous: RunControlFormState,
  _formData: FormData,
): Promise<RunControlFormState> {
  const result = await runPipelineAction(async () => cancelActivity(projectId));
  return { error: result.error };
}
