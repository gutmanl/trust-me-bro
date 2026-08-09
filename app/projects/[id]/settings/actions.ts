"use server";

import { revalidatePath } from "next/cache";

import { parseBackendCli } from "@/app/lib/parse-backend-cli";
import { runPipelineAction } from "@/app/lib/pipeline-action";
import { updateProjectConfig } from "@/lib/pipeline";

export interface SettingsFormState {
  error: string | null;
  /** Changed fields of the last successful submit; [] = no-op submit. */
  changedFields?: string[];
}

export async function updateProjectConfigAction(
  projectId: string,
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const primaryCli = parseBackendCli(formData.get("primary_cli"));
  if (!primaryCli) {
    return { error: "Bitte ein primäres Backend wählen." };
  }
  const secondaryCli = parseBackendCli(formData.get("secondary_cli"));
  const result = await runPipelineAction(() =>
    updateProjectConfig(projectId, {
      rubricVersion: String(formData.get("rubric_version") ?? ""),
      adjudicationSampleRate: Number(formData.get("adjudication_sample_rate")),
      maxRepairCycles: Number(formData.get("max_repair_cycles")),
      primaryCli,
      secondaryCli,
      ...(secondaryCli
        ? {
            secondOpinion: {
              confidenceThreshold: Number(formData.get("confidence_threshold")),
              onRelationNotSupports:
                formData.get("on_relation_not_supports") === "on",
            },
          }
        : {}),
    }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/settings`);
  return { error: null, changedFields: result.value.changedFields };
}
