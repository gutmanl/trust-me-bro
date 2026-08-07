"use server";

import { redirect } from "next/navigation";

import { importBriefing, PipelineError } from "@/lib/pipeline";

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

  try {
    await importBriefing({ projectId, content, tool });
  } catch (error) {
    if (error instanceof PipelineError) {
      return { error: error.message };
    }
    throw error;
  }
  redirect(`/projects/${projectId}`);
}
