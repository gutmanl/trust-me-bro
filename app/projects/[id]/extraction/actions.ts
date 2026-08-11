"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { startUnevidencedExtraction } from "@/lib/pipeline";

export interface ExtractionFormState {
  error: string | null;
  started?: boolean;
}

/** Starts the sweep for claims that cite no captured source. The per-source
 * passes are triggered from the source list of the workbench (Task 11); this
 * page keeps the one pass that belongs to no single source. */
export async function startExtractionAction(
  projectId: string,
  _previous: ExtractionFormState,
  _formData: FormData,
): Promise<ExtractionFormState> {
  const result = await runPipelineAction(() =>
    startUnevidencedExtraction(projectId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/extraction`);
  return { error: null, started: true };
}
