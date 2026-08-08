"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import type { ComplaintCategory, RepairOutput } from "@/lib/pipeline";
import {
  applyRepair,
  decideClaim,
  discardClaim,
  proposeRepair,
  RunActiveError,
  startVerification,
  VerificationPreconditionError,
} from "@/lib/pipeline";

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

export interface RepairProposalFormState {
  error: string | null;
  suggestion?: RepairOutput;
}

/** Asks the primary backend for a reformulation proposal — read-only, the
 * reviewer decides in the panel what happens with it. */
export async function proposeRepairAction(
  projectId: string,
  claimId: string,
  _previous: RepairProposalFormState,
  _formData: FormData,
): Promise<RepairProposalFormState> {
  const result = await runPipelineAction(() =>
    proposeRepair(projectId, claimId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  const outcome = result.value;
  if (outcome.status === "paused") {
    return { error: `Backend pausiert (Rate-Limit): ${outcome.reason}` };
  }
  if (outcome.status === "exhausted") {
    return { error: outcome.message };
  }
  return { error: null, suggestion: outcome.suggestion };
}

export interface ApplyRepairFormState {
  error: string | null;
  applied?: boolean;
  reentryTarget?: string;
}

/** Persists the accepted/adjusted wording and re-enters the affected
 * stages; a verification run is started opportunistically so the revised
 * claim is re-checked without a manual detour. */
export async function applyRepairAction(
  projectId: string,
  claimId: string,
  _previous: ApplyRepairFormState,
  formData: FormData,
): Promise<ApplyRepairFormState> {
  const newText = String(formData.get("new_text") ?? "");
  const source = String(formData.get("source") ?? "manuell") as
    "vorschlag_uebernommen" | "vorschlag_angepasst" | "manuell";
  const proposedText = String(formData.get("proposed_text") ?? "");
  const result = await runPipelineAction(() =>
    applyRepair(projectId, claimId, { newText, source, proposedText }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  if (result.value.reentryTarget !== "zur_adjudikation") {
    try {
      await startVerification(projectId);
    } catch (error) {
      // Best effort: an active run picks nothing up twice, and a precondition
      // error just means the reviewer starts the run manually later.
      if (
        !(error instanceof RunActiveError) &&
        !(error instanceof VerificationPreconditionError)
      ) {
        throw error;
      }
    }
  }
  revalidatePath(`/projects/${projectId}/review`);
  return {
    error: null,
    applied: true,
    reentryTarget: result.value.reentryTarget,
  };
}

/** Discard after failed/declined repair — the claim stays in the register. */
export async function discardClaimAction(
  projectId: string,
  claimId: string,
  _previous: DecisionFormState,
  formData: FormData,
): Promise<DecisionFormState> {
  const reason = String(formData.get("reason") ?? "");
  const result = await runPipelineAction(() =>
    discardClaim(projectId, claimId, reason),
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
