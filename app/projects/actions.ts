"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { archiveProject } from "@/lib/pipeline";

export interface ArchiveProjectFormState {
  error: string | null;
}

/**
 * Archives a project from the project list. On success revalidates the list
 * so the card disappears; a PipelineError (unknown project, or a run still
 * active for it) becomes the form's error message instead.
 */
export async function archiveProjectAction(
  projectId: string,
  _previous: ArchiveProjectFormState,
  _formData: FormData,
): Promise<ArchiveProjectFormState> {
  const result = await runPipelineAction(() => archiveProject(projectId));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath("/projects");
  return { error: null };
}
