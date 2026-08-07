"use server";

import { redirect } from "next/navigation";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { importBriefing } from "@/lib/pipeline";

export interface ImportBriefingFormState {
  error: string | null;
}

export async function importBriefingAction(
  projectId: string,
  _previous: ImportBriefingFormState,
  formData: FormData,
): Promise<ImportBriefingFormState> {
  const file = formData.get("file");
  const pasted = String(formData.get("content") ?? "");
  const tool = String(formData.get("tool") ?? "");

  let content = pasted;
  if (file instanceof File && file.size > 0) {
    content = await file.text();
  }

  const result = await runPipelineAction(() =>
    importBriefing({ projectId, content, tool }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  redirect(`/projects/${projectId}`);
}
