"use server";

import { redirect } from "next/navigation";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { completeFirstRunSetup, setUnpaywallEmail } from "@/lib/pipeline";

export interface SetupFormState {
  error: string | null;
}

export async function completeSetupAction(
  _previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const actorHandle = String(formData.get("actor_handle") ?? "").trim();
  const unpaywallEmail = String(formData.get("unpaywall_email") ?? "").trim();

  // Validate/save the optional Unpaywall address FIRST: it is entirely
  // optional (setup must still complete when left empty), but if the user
  // typed something invalid, fail before the irreversible actor-handle
  // write rather than leaving setup half-done.
  if (unpaywallEmail) {
    const emailResult = await runPipelineAction(() =>
      setUnpaywallEmail(unpaywallEmail),
    );
    if (emailResult.error !== null) {
      return { error: emailResult.error };
    }
  }

  const result = await runPipelineAction(async () =>
    completeFirstRunSetup({ actorHandle }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  redirect("/projects");
}
