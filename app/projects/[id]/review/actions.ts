"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import type { ComplaintCategory } from "@/lib/pipeline";
import { decideClaim } from "@/lib/pipeline";

export interface DecisionFormState {
  error: string | null;
  decided?: boolean;
}

function parseDurationS(formData: FormData): number {
  const raw = Number(formData.get("duration_s"));
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/** Confirmation: empty category set (TMB-35). */
export async function confirmClaimAction(
  projectId: string,
  claimId: string,
  _previous: DecisionFormState,
  formData: FormData,
): Promise<DecisionFormState> {
  const result = await runPipelineAction(() =>
    decideClaim(projectId, claimId, {
      categories: [],
      durationS: parseDurationS(formData),
    }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/review`);
  return { error: null, decided: true };
}

/** Complaint: transitions to beanstandet; the repair step follows there. */
export async function complainClaimAction(
  projectId: string,
  claimId: string,
  _previous: DecisionFormState,
  formData: FormData,
): Promise<DecisionFormState> {
  const categories = formData.getAll("categories") as ComplaintCategory[];
  const justification = String(formData.get("justification") ?? "");
  const result = await runPipelineAction(() =>
    decideClaim(projectId, claimId, {
      categories,
      justification,
      durationS: parseDurationS(formData),
    }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/review`);
  return { error: null, decided: true };
}
