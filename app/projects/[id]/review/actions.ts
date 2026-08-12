"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import type { ComplaintCategory, RepairOutput } from "@/lib/pipeline";
import {
  applyRepair,
  decideClaim,
  discardClaim,
  proposeRepair,
  repairBriefingPassage,
  repairClaimAnchor,
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
  if (result.value.reentryTarget !== "pending_adjudication") {
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

export interface AnchorRepairFormState {
  error: string | null;
  repaired?: boolean;
}

/**
 * Manual re-anchor of a claim (workbench epic): the text is right, the
 * anchor drifted. Available in any claim status — a misplaced anchor is a
 * bookkeeping defect, not a verdict — and refused by the pipeline unless the
 * quote actually occurs in the chosen paragraph.
 */
export async function repairClaimAnchorAction(
  projectId: string,
  claimId: string,
  _previous: AnchorRepairFormState,
  formData: FormData,
): Promise<AnchorRepairFormState> {
  const anchor = String(formData.get("anchor") ?? "");
  const quote = String(formData.get("quote") ?? "");
  const result = await runPipelineAction(() =>
    repairClaimAnchor(projectId, claimId, { anchor, quote }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null, repaired: true };
}

/**
 * The other direction: the anchor is right, the PASSAGE is wrong. Rewrites
 * that one paragraph and publishes the result as an ordinary briefing
 * revision, whose silent re-anchor pass follows every claim whose quote
 * moved. The claim itself keeps its status and goes on through its normal
 * repair re-entry.
 */
export async function repairBriefingPassageAction(
  projectId: string,
  claimId: string,
  _previous: AnchorRepairFormState,
  formData: FormData,
): Promise<AnchorRepairFormState> {
  const passage = String(formData.get("passage") ?? "");
  const result = await runPipelineAction(() =>
    repairBriefingPassage(projectId, claimId, passage),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null, repaired: true };
}

/** Complaint: transitions to contested; the repair step follows there. */
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
