"use server";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { runInstallationLoginProbe } from "@/lib/pipeline";

export interface InstallationProbeFormState {
  error: string | null;
}

/**
 * Installation-level stage-3 probe (TMB-54, D7): one real, minimal call
 * against the selected CLI, triggered by a button because it spends a small
 * quota share. Mirrors the per-project probe action on the status page; the
 * result lands in the adapter layer's cache, so the caller only has to
 * refresh.
 */
export async function runInstallationProbeAction(
  cli: string,
  _previous: InstallationProbeFormState,
  _formData: FormData,
): Promise<InstallationProbeFormState> {
  const result = await runPipelineAction(() => runInstallationLoginProbe(cli));
  return { error: result.error };
}
