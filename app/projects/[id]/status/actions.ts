"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { runLoginProbe } from "@/lib/pipeline";

export interface LoginProbeFormState {
  error: string | null;
  checked?: boolean;
}

export async function runLoginProbeAction(
  projectId: string,
  which: "primary" | "secondary",
  _previous: LoginProbeFormState,
  _formData: FormData,
): Promise<LoginProbeFormState> {
  const result = await runPipelineAction(() => runLoginProbe(projectId, which));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/status`);
  return { error: null, checked: true };
}
