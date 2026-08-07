"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { startExtraction } from "@/lib/pipeline";

export interface ExtractionFormState {
  error: string | null;
  started?: boolean;
}

export async function startExtractionAction(
  projectId: string,
  _previous: ExtractionFormState,
  _formData: FormData,
): Promise<ExtractionFormState> {
  const result = await runPipelineAction(() => startExtraction(projectId));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/extraction`);
  return { error: null, started: true };
}
