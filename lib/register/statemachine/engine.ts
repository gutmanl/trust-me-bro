import type { ActorId } from "../../identity/types";
import type { ChainAppender } from "../chain/appender";
import type { Claim } from "../schema/claim";
import type { ClaimStatus, RoutingReason } from "../schema/enums";
import type { Decision, HistoryEntry, Revision } from "../schema/history";
import { isAtomicClaimText } from "./atomicity";
import {
  DecisionRequiredError,
  GateRejectedError,
  InvalidTransitionError,
} from "./errors";
import { edgeExists, findTransition } from "./transitions";

export interface TransitionRequest {
  to: ClaimStatus;
  actor: ActorId;
  reason: string;
  at?: string;
  decision?: Decision;
  /** Structured routing reason; only meaningful on transitions into
   * `pending_adjudication` (queue grouping, TMB-36). */
  routing?: RoutingReason;
  /** Text revision of the repair loop; only meaningful on the
   * `contested → revised` edge (TMB-37). */
  revision?: Revision;
}

function actorKind(actor: ActorId): "system" | "human" {
  return actor.startsWith("human:") ? "human" : "system";
}

function checkDecision(
  claim: Claim,
  request: TransitionRequest,
  requirement: "category_null" | "category_required" | "optional" | undefined,
): void {
  const { decision } = request;
  if (!requirement) {
    if (decision) {
      throw new DecisionRequiredError(
        claim.id,
        request.to,
        "system transitions must not carry a decision object",
      );
    }
    return;
  }
  if (requirement === "optional") {
    return;
  }
  if (!decision) {
    throw new DecisionRequiredError(
      claim.id,
      request.to,
      "decision object missing",
    );
  }
  if (requirement === "category_null" && decision.categories.length !== 0) {
    throw new DecisionRequiredError(
      claim.id,
      request.to,
      "a confirmation carries an empty categories array",
    );
  }
  if (requirement === "category_required" && decision.categories.length === 0) {
    throw new DecisionRequiredError(
      claim.id,
      request.to,
      "a complaint requires at least one complaint category",
    );
  }
  if (
    decision.reviewed_evidence_ids.some(
      (id) => !claim.evidence.find((e) => e.id === id),
    )
  ) {
    throw new DecisionRequiredError(
      claim.id,
      request.to,
      "reviewed_evidence_ids reference unknown evidence",
    );
  }
}

/**
 * The sole status mutator: checks the edge (including actor kind), its gate
 * condition and the decision requirement, then sets the status and appends
 * exactly one chain-linked history entry. Throws without side effects — the
 * chain appender is only advanced after all checks pass.
 */
export function applyTransition(
  claim: Claim,
  chain: ChainAppender,
  request: TransitionRequest,
): HistoryEntry {
  const from = claim.status;
  const def = findTransition(from, request.to, actorKind(request.actor));
  if (!def) {
    throw new InvalidTransitionError(
      claim.id,
      from,
      request.to,
      edgeExists(from, request.to)
        ? `not allowed for ${actorKind(request.actor)} actors`
        : undefined,
    );
  }
  const gateResult = def.gate(claim);
  if (!gateResult.ok) {
    throw new GateRejectedError(claim.id, from, request.to, gateResult.reason);
  }
  checkDecision(claim, request, def.decision);

  const entry = chain.append({
    at: request.at ?? new Date().toISOString(),
    actor: request.actor,
    from_status: from,
    to_status: request.to,
    reason: request.reason,
    ...(request.decision ? { decision: request.decision } : {}),
    ...(request.routing ? { routing: request.routing } : {}),
    ...(request.revision ? { revision: request.revision } : {}),
  }) as HistoryEntry;
  claim.status = request.to;
  claim.history.push(entry);
  return entry;
}

/**
 * Creates a claim through the extraction gate: the initial status is decided
 * by the evidence-completeness gate (evidence present → captured, none →
 * pending_adjudication) and the atomicity gate (bundled statements →
 * pending_adjudication), never by the caller.
 */
export function createClaim(
  draft: { claims: Claim[] },
  chain: ChainAppender,
  input: {
    claim: Omit<Claim, "status" | "history">;
    actor: ActorId;
    reason: string;
    at?: string;
  },
): Claim {
  if (actorKind(input.actor) !== "system") {
    throw new InvalidTransitionError(
      input.claim.id,
      null,
      "captured",
      "creation is system-only",
    );
  }
  const to: ClaimStatus =
    input.claim.evidence.length > 0 && isAtomicClaimText(input.claim.text)
      ? "captured"
      : "pending_adjudication";
  // The claim starts with from_status null; applyTransition performs the
  // creation edge so it gets its gate check and chain link exactly like
  // every later transition. Missing evidence is the routed condition
  // (TMB-36 queue); the atomicity rejection stays unrouted — it is no value
  // of the ratified RoutingReason enum and buckets as "unassigned".
  const claim: Claim = {
    ...structuredClone(input.claim),
    status: null as unknown as ClaimStatus,
    history: [],
  };
  applyTransition(claim, chain, {
    to,
    actor: input.actor,
    reason: input.reason,
    at: input.at,
    ...(to === "pending_adjudication" && input.claim.evidence.length === 0
      ? { routing: "no_evidence" as const }
      : {}),
  });
  draft.claims.push(claim);
  return claim;
}

/**
 * Creates an adopted claim of a warm run (TMB-43): unlike createClaim, the
 * claim is created directly INTO its settled origin status — it arrives
 * fully verified from the origin project and was never unchecked here. The
 * adoption edges' gate enforces that the claim carries
 * provenance.origin_project_id, so this path is structurally closed to
 * normal extraction. Deliberately a separate capability from createClaim:
 * least surprise — extraction can never accidentally mint a pre-confirmed
 * claim.
 */
export function adoptClaim(
  draft: { claims: Claim[] },
  chain: ChainAppender,
  input: {
    claim: Omit<Claim, "status" | "history">;
    /** The settled status the claim held in the origin project. */
    targetStatus: "confirmed" | "auto_confirmed" | "discarded";
    actor: ActorId;
    reason: string;
    at?: string;
  },
): Claim {
  if (actorKind(input.actor) !== "system") {
    throw new InvalidTransitionError(
      input.claim.id,
      null,
      input.targetStatus,
      "adoption is system-only",
    );
  }
  const claim: Claim = {
    ...structuredClone(input.claim),
    status: null as unknown as ClaimStatus,
    history: [],
  };
  applyTransition(claim, chain, {
    to: input.targetStatus,
    actor: input.actor,
    reason: input.reason,
    at: input.at,
  });
  draft.claims.push(claim);
  return claim;
}
