"use server";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { cancelRun, pauseRun, resumeRun } from "@/lib/pipeline";

/**
 * Shared pause/resume/cancel actions of the multi-item run panels
 * (verification, relevance; TMB-50) — one implementation instead of a
 * per-feature triplet, mirroring the useJobStream dedup rationale.
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
