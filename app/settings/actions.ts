"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { setUnpaywallEmail, updateActorHandle } from "@/lib/pipeline";

export interface InstallationSettingsFormState {
  error: string | null;
  saved?: string;
}

/**
 * Changes the actor handle (TMB-54, D6). No redirect: the user stays on the
 * settings page and sees the confirmation, including the reminder that past
 * history entries keep the old handle.
 */
export async function updateActorHandleAction(
  _previous: InstallationSettingsFormState,
  formData: FormData,
): Promise<InstallationSettingsFormState> {
  const handle = String(formData.get("actor_handle") ?? "").trim();
  const result = await runPipelineAction(async () => updateActorHandle(handle));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath("/settings");
  return { error: null, saved: handle };
}

/** Sets or clears the installation's Unpaywall address. */
export async function updateUnpaywallAction(
  _previous: InstallationSettingsFormState,
  formData: FormData,
): Promise<InstallationSettingsFormState> {
  const email = String(formData.get("unpaywall_email") ?? "").trim();
  const result = await runPipelineAction(() =>
    setUnpaywallEmail(email === "" ? null : email),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath("/settings");
  return { error: null, saved: email === "" ? "(entfernt)" : email };
}
