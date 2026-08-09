"use server";

import { redirect } from "next/navigation";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { completeFirstRunSetup } from "@/lib/pipeline";

export interface SetupFormState {
  error: string | null;
}

export async function completeSetupAction(
  _previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const actorHandle = String(formData.get("actor_handle") ?? "").trim();
  const result = await runPipelineAction(async () =>
    completeFirstRunSetup({ actorHandle }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  redirect("/projects");
}
