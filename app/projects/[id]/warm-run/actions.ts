"use server";

import { redirect } from "next/navigation";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { createWarmRunProject } from "@/lib/pipeline";

export interface WarmRunFormState {
  error: string | null;
}

export async function createWarmRunAction(
  originProjectId: string,
  _previous: WarmRunFormState,
  formData: FormData,
): Promise<WarmRunFormState> {
  const newProjectId = String(formData.get("project_id") ?? "").trim();
  const newResearchQuestion = String(
    formData.get("research_question") ?? "",
  ).trim();
  const result = await runPipelineAction(() =>
    createWarmRunProject({
      originProjectId,
      newProjectId,
      newResearchQuestion,
    }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  redirect(`/projects/${result.value.projectId}`);
}
