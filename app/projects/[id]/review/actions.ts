"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import type { ComplaintCategory, RepairOutput } from "@/lib/pipeline";
import {
  applyRepair,
  decideClaim,
  discardClaim,
  dismissClaimRepairSuggestion,
  enqueueAnchorRepair,
  enqueueClaimRepairEvaluations,
  proposeRepair,
  repairBriefingPassage,
  repairClaimAnchor,
  requestClaimRecheck,
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
  revalidatePath(`/projects/${projectId}`);
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
  /** Verdict-driven repair: the claim half applied but the briefing half
   * did not — the German precondition explains why. */
  briefingError?: string;
}

/** The accepted excerpt corrections, carried as one hidden JSON field
 * (verdict-driven repair). The field is app-authored — the suggestion box
 * serializes the suggestion's own `evidenceRepairs` — so a malformed value
 * is a programming error and throws rather than silently dropping the
 * corrections the reviewer believed they accepted. */
function parseExcerptRepairs(
  formData: FormData,
): { evidenceId: string; correctedExcerpt: string }[] {
  const raw = String(formData.get("excerpt_repairs") ?? "").trim();
  if (raw === "") {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { evidenceId?: unknown }).evidenceId !== "string" ||
        typeof (entry as { correctedExcerpt?: unknown }).correctedExcerpt !==
          "string",
    )
  ) {
    throw new Error("excerpt_repairs: malformed hidden field");
  }
  return parsed as { evidenceId: string; correctedExcerpt: string }[];
}

export interface RepairSuggestionRequestState {
  error: string | null;
  queued?: number;
}

/** Verdict-driven repair: queues suggestion generation — for one claim
 * (`claimId` set) or the whole eligible backlog of the project. The
 * generation itself runs off the auto-chain; the card fills in via the
 * trigger's terminal event and the stream's refresh. */
export async function requestClaimRepairSuggestionsAction(
  projectId: string,
  claimId: string | null,
  _previous: RepairSuggestionRequestState,
  _formData: FormData,
): Promise<RepairSuggestionRequestState> {
  const result = await runPipelineAction(() =>
    enqueueClaimRepairEvaluations(
      projectId,
      claimId === null ? undefined : [claimId],
    ),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  return { error: null, queued: result.value };
}

/** Verdict-driven repair: the human judgment "this proposal is not it" —
 * the suggestion disappears, the chain keeps it. */
export async function dismissClaimRepairSuggestionAction(
  projectId: string,
  claimId: string,
  _previous: DecisionFormState,
  _formData: FormData,
): Promise<DecisionFormState> {
  const result = await runPipelineAction(() =>
    dismissClaimRepairSuggestion(projectId, claimId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null, decided: true };
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
  const excerptRepairs = parseExcerptRepairs(formData);
  // Verdict-driven repair: the briefing half runs FIRST — applying the
  // claim opportunistically starts a verification run below, and a running
  // run blocks publishBriefingRevision. Its failure never blocks the claim
  // half (operator decision 2026-08-24): the German precondition travels
  // back beside the applied state instead.
  const briefingRepair = String(formData.get("briefing_repair") ?? "").trim();
  const applyBriefing = formData.get("apply_briefing") === "on";
  let briefingError: string | undefined;
  if (briefingRepair !== "" && applyBriefing) {
    const briefingResult = await runPipelineAction(() =>
      repairBriefingPassage(projectId, claimId, briefingRepair),
    );
    if (briefingResult.error !== null) {
      briefingError = briefingResult.error;
    } else {
      // The rewrite usually removes the very wording old anchor quotes bind
      // to — give orphaned quotes their bounded fuzzy re-anchor attempt.
      enqueueAnchorRepair(projectId);
    }
  }
  const result = await runPipelineAction(() =>
    applyRepair(projectId, claimId, {
      newText,
      source,
      proposedText,
      ...(excerptRepairs.length > 0 ? { excerptRepairs } : {}),
    }),
  );
  if (result.error !== null) {
    return {
      error: result.error,
      ...(briefingError !== undefined ? { briefingError } : {}),
    };
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
  // On a partial apply the revalidation is deliberately skipped: it would
  // re-render the card, unmount the suggestion box and take the briefing
  // error (and the proposal text needed for a later manual apply) with it.
  // The stale card is one navigation away; the explanation is not.
  if (briefingError === undefined) {
    revalidatePath(`/projects/${projectId}`);
  }
  return {
    error: null,
    applied: true,
    reentryTarget: result.value.reentryTarget,
    ...(briefingError !== undefined ? { briefingError } : {}),
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
  revalidatePath(`/projects/${projectId}`);
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
  // Gap fix (verdict-driven repair): the manual passage repair never
  // triggered the fuzzy sweep, unlike the editor publish — a rewritten
  // passage is exactly the case where anchor quotes stop resolving.
  enqueueAnchorRepair(projectId);
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
  revalidatePath(`/projects/${projectId}`);
  return { error: null, decided: true };
}

export interface RecheckFormState {
  error: string | null;
  requested?: boolean;
}

/**
 * Reviewer-triggered re-verification of a single claim (RERUN-01): marks it
 * for Nachprüfung. It starts no run — the reviewer's next „KI-Prüfung
 * starten" is what re-checks it — so a success here means „vorgemerkt", not
 * „geprüft", and the card's copy says exactly that.
 *
 * A live run makes the request impossible, and `RunActiveError`'s shipped
 * message already names the blocking activity and its start time; it
 * reaches the card verbatim through `runPipelineAction`.
 */
export async function requestClaimRecheckAction(
  projectId: string,
  claimId: string,
  _previous: RecheckFormState,
  _formData: FormData,
): Promise<RecheckFormState> {
  const result = await runPipelineAction(() =>
    requestClaimRecheck({ projectId, claimIds: [claimId] }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}`);
  return { error: null, requested: true };
}
