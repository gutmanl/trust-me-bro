"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { startVerification } from "@/lib/pipeline";

export interface VerificationFormState {
  error: string | null;
  started?: boolean;
}

export async function startVerificationAction(
  projectId: string,
  _previous: VerificationFormState,
  _formData: FormData,
): Promise<VerificationFormState> {
  const result = await runPipelineAction(() => startVerification(projectId));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/verification`);
  return { error: null, started: true };
}
