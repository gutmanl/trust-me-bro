"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { startRelevanceCheck } from "@/lib/pipeline";

export interface RelevanceFormState {
  error: string | null;
  started?: boolean;
}

export async function startRelevanceAction(
  projectId: string,
  _previous: RelevanceFormState,
  _formData: FormData,
): Promise<RelevanceFormState> {
  const result = await runPipelineAction(() => startRelevanceCheck(projectId));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/relevance`);
  return { error: null, started: true };
}
