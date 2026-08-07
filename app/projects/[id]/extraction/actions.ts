"use server";

import { revalidatePath } from "next/cache";

import { PipelineError, startExtraction } from "@/lib/pipeline";

export interface ExtractionFormState {
  error: string | null;
  started?: boolean;
}

export async function startExtractionAction(
  projectId: string,
  _previous: ExtractionFormState,
  _formData: FormData,
): Promise<ExtractionFormState> {
  try {
    await startExtraction(projectId);
    revalidatePath(`/projects/${projectId}/extraction`);
    return { error: null, started: true };
  } catch (error) {
    if (error instanceof PipelineError) {
      return { error: error.message };
    }
    throw error;
  }
}
