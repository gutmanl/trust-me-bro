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

  // Persist the actor handle FIRST (C1 fix): on a genuine first run there
  // is no config file and no TMB_ACTOR_HANDLE yet, so saving the optional
  // Unpaywall address before an identity exists has nothing to attach
  // itself to and crashes with IdentityNotConfiguredError — an English,
  // non-PipelineError that runPipelineAction cannot turn into form state.
  // The Unpaywall step is genuinely optional (setup must still complete
  // when it is left empty, or if it fails validation) and can always be
  // retried afterwards from the sources page, so it runs second.
  const result = await runPipelineAction(async () =>
    completeFirstRunSetup({ actorHandle }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }

  if (unpaywallEmail) {
    const emailResult = await runPipelineAction(() =>
      setUnpaywallEmail(unpaywallEmail),
    );
    if (emailResult.error !== null) {
      return { error: emailResult.error };
    }
  }

  redirect("/projects");
}
