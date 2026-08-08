"use server";

import { redirect } from "next/navigation";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { createProject } from "@/lib/pipeline";
import type { BackendCli } from "@/lib/pipeline";

export interface CreateProjectFormState {
  error: string | null;
}

function parseCli(value: FormDataEntryValue | null): BackendCli | undefined {
  // "anthropic-api" is accepted here but re-gated server-side: the pipeline
  // rejects it while the TMB-51 feature flag is off.
  return value === "claude" || value === "codex" || value === "anthropic-api"
    ? value
    : undefined;
}

export async function createProjectAction(
  _previous: CreateProjectFormState,
  formData: FormData,
): Promise<CreateProjectFormState> {
  const id = String(formData.get("id") ?? "").trim();
  const research_question = String(
    formData.get("research_question") ?? "",
  ).trim();
  const primaryCli = parseCli(formData.get("primary_cli"));
  const secondaryCli = parseCli(formData.get("secondary_cli"));

  if (!primaryCli) {
    return { error: "Bitte eine primäre Modellfamilie wählen." };
  }
  const result = await runPipelineAction(() =>
    createProject({ id, research_question, primaryCli, secondaryCli }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  redirect(`/projects/${id}`);
}
