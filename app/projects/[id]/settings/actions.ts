"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { updateProjectConfig } from "@/lib/pipeline";
import type { BackendCli } from "@/lib/pipeline";

export interface SettingsFormState {
  error: string | null;
  /** Changed fields of the last successful submit; [] = no-op submit. */
  changedFields?: string[];
}

// "anthropic-api" is accepted here but re-gated server-side: the pipeline
// rejects it while the TMB-51 feature flag is off.
const BACKEND_CLIS = ["claude", "codex", "anthropic-api"] as const;

function parseCli(value: FormDataEntryValue | null): BackendCli | undefined {
  const text = String(value ?? "").trim();
  return (BACKEND_CLIS as readonly string[]).includes(text)
    ? (text as BackendCli)
    : undefined;
}

export async function updateProjectConfigAction(
  projectId: string,
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const primaryCli = parseCli(formData.get("primary_cli"));
  if (!primaryCli) {
    return { error: "Bitte ein primäres Backend wählen." };
  }
  const secondaryCli = parseCli(formData.get("secondary_cli"));
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
              onRelationNotStuetzt:
                formData.get("on_relation_not_stuetzt") === "on",
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
