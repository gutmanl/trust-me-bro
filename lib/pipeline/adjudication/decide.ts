import { getCurrentActor } from "../../identity";
import type { ComplaintCategory, HistoryEntry } from "../../register";
import { AdjudicationPreconditionError } from "../errors";
import { requireProjectStore } from "../projects";

/**
 * The binding human adjudication decision (TMB-35): an empty category set
 * confirms (`pending_adjudication → confirmed`), a non-empty one complains
 * (`→ contested`). Discarding directly is impossible by design — the
 * state machine offers repair first. The decision object versions the
 * multi-select categories, the reviewed evidence and the casually measured
 * duration in the claim's history entry; a silent text change past the
 * register cannot happen because this transaction is the only write path.
 */

export interface AdjudicationDecisionInput {
  /** Empty = confirmation; one or more categories = complaint. */
  categories: ComplaintCategory[];
  /** Free-text justification; mandatory when "other" is selected. */
  justification?: string;
  /** Casually measured decision duration (effort measure A5). */
  durationS: number;
}

export async function decideClaim(
  projectId: string,
  claimId: string,
  input: AdjudicationDecisionInput,
): Promise<HistoryEntry> {
  const justification = input.justification?.trim() ?? "";
  if (input.categories.includes("other") && justification.length === 0) {
    throw new AdjudicationPreconditionError(
      "„Sonstiges“ erfordert eine Begründung.",
    );
  }
  if (!Number.isFinite(input.durationS) || input.durationS < 0) {
    throw new AdjudicationPreconditionError(
      "Die Bearbeitungsdauer ist nicht messbar – Entscheidung nicht übertragen.",
    );
  }

  const store = requireProjectStore(projectId);
  return store.transaction((tx) => {
    const claim = tx.listClaims().find((candidate) => candidate.id === claimId);
    if (!claim) {
      throw new AdjudicationPreconditionError(
        `Claim "${claimId}" existiert nicht.`,
      );
    }
    if (claim.status !== "pending_adjudication") {
      throw new AdjudicationPreconditionError(
        `Claim "${claimId}" steht nicht zur Adjudikation (Status: ${claim.status}).`,
      );
    }
    const confirm = input.categories.length === 0;
    const reason = confirm
      ? `Adjudikation: bestätigt.${justification ? ` ${justification}` : ""}`
      : `Adjudikation: beanstandet (${input.categories.join(", ")}).` +
        (justification ? ` ${justification}` : "");
    return tx.transitionClaim(claimId, {
      to: confirm ? "confirmed" : "contested",
      actor: getCurrentActor(),
      reason,
      decision: {
        categories: input.categories,
        // Casual measurement rule: a decision reviews the claim's evidence
        // as presented in the panel — all of it, no per-card tracking.
        reviewed_evidence_ids: claim.evidence.map((evidence) => evidence.id),
        duration_s: input.durationS,
      },
    });
  });
}
