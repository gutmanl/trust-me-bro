"use server";

import { redirect } from "next/navigation";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import {
  completeFirstRunSetup,
  createDemoProject,
  DEMO_PROJECT_ID,
  setUnpaywallEmail,
  setWorkspaceRoot,
} from "@/lib/pipeline";

export interface SetupFormState {
  error: string | null;
}

/**
 * Step 1 of the wizard, and the only mandatory one: the actor handle.
 *
 * It must run FIRST (C1 fix): on a genuine first run there is no config
 * file and no TMB_ACTOR_HANDLE yet, so saving anything else before an
 * identity exists has nothing to attach itself to and crashes with
 * IdentityNotConfiguredError — an English, non-PipelineError that
 * runPipelineAction cannot turn into form state. That is also why this
 * action still accepts an optional unpaywall_email and writes it second:
 * the ordering guarantee is covered by tests/first-run-setup.test.ts, and
 * the wizard's own step 4 uses saveUnpaywallAction instead.
 *
 * "Setup complete" deliberately keeps its old meaning — actor handle
 * present (D4). Steps 2 to 5 are optional and skippable, so closing the tab
 * mid-wizard leaves a usable installation rather than locking the user out.
 */
export async function completeSetupAction(
  _previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const actorHandle = String(formData.get("actor_handle") ?? "").trim();
  const unpaywallEmail = String(formData.get("unpaywall_email") ?? "").trim();

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

  redirect(`/setup?step=${String(formData.get("next_step") ?? "2")}`);
}

/** Step 2: the workspace directory (D5 — first run only). */
export async function saveWorkspaceAction(
  _previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const root = String(formData.get("workspace_root") ?? "").trim();
  const result = await runPipelineAction(async () => setWorkspaceRoot(root));
  if (result.error !== null) {
    return { error: result.error };
  }
  redirect("/setup?step=3");
}

/** Step 4: the optional Unpaywall address. */
export async function saveUnpaywallAction(
  _previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const email = String(formData.get("unpaywall_email") ?? "").trim();
  if (email) {
    const result = await runPipelineAction(() => setUnpaywallEmail(email));
    if (result.error !== null) {
      return { error: result.error };
    }
  }
  redirect("/setup?step=5");
}

/**
 * Step 5, and the empty project list: the example project, on explicit
 * request (D3). A second call surfaces the existing
 * ProjectAlreadyExistsError as ordinary German form state.
 */
export async function createDemoProjectAction(
  _previous: SetupFormState,
  _formData: FormData,
): Promise<SetupFormState> {
  const result = await runPipelineAction(() => createDemoProject());
  if (result.error !== null) {
    return { error: result.error };
  }
  redirect(`/projects/${DEMO_PROJECT_ID}`);
}
