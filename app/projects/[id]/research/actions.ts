"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { startResearch } from "@/lib/pipeline";

export interface ResearchFormState {
  error: string | null;
  started?: boolean;
}

export async function startResearchAction(
  projectId: string,
  _previous: ResearchFormState,
  _formData: FormData,
): Promise<ResearchFormState> {
  const result = await runPipelineAction(() => startResearch(projectId));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/research`);
  return { error: null, started: true };
}
