import type { ActorId } from "../../identity/types";
import type { ChainAppender } from "../chain/appender";
import type { Claim } from "../schema/claim";
import type { ClaimStatus } from "../schema/enums";
import type { Decision, HistoryEntry } from "../schema/history";
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
  if (requirement === "category_null" && decision.category !== null) {
    throw new DecisionRequiredError(
      claim.id,
      request.to,
      "a confirmation carries category null",
    );
  }
  if (requirement === "category_required" && decision.category === null) {
    throw new DecisionRequiredError(
      claim.id,
      request.to,
      "a complaint requires a complaint category",
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
  }) as HistoryEntry;
  claim.status = request.to;
  claim.history.push(entry);
  return entry;
}

/**
 * Creates a claim through the extraction gate: the initial status is decided
 * by the Nachweisvollständigkeits-Gate (evidence present → erfasst, none →
 * zur_adjudikation) and the Atomaritäts-Gate (bundled statements →
 * zur_adjudikation), never by the caller.
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
      "erfasst",
      "creation is system-only",
    );
  }
  const to: ClaimStatus =
    input.claim.evidence.length > 0 && isAtomicClaimText(input.claim.text)
      ? "erfasst"
      : "zur_adjudikation";
  // The claim starts with from_status null; applyTransition performs the
  // creation edge so it gets its gate check and chain link exactly like
  // every later transition.
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
  });
  draft.claims.push(claim);
  return claim;
}
