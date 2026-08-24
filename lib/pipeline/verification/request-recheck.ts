import { getCurrentActor } from "../../identity";
import type { Claim, ClaimsRegister } from "../../register";
import { RunActiveError } from "../errors";
import { requireProjectStore } from "../projects";
import { describeBlockingActivity } from "../runs/control";
import { getGlobalJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import { RECHECK_STATUSES } from "./recheck-statuses";

/**
 * Actor of the transition itself.
 *
 * A re-run is human-INITIATED but system-EXECUTED: the reviewer asks for
 * it, the machine performs the move and will perform the re-check. Writing
 * the reviewer into `history[].actor` would report the audit trail the
 * thesis cites as if a human had personally re-classified the claim. The
 * human's intent is recorded instead on the bracket event, whose actor is
 * the real reviewer and whose German reason says what they asked for.
 *
 * The transition table independently requires it: every
 * `* → recheck_required` edge is declared `actorKind: "system"`, so a human
 * actor here would be refused at the gate.
 */
const RECHECK_ACTOR = "system:recheck_request" as const;

/** Persisted German prose on the claim's own history entry. */
const TRANSITION_REASON =
  "Erneute Prüfung angefordert: die Aussage durchläuft die Prüfstufen " +
  "noch einmal, beginnend bei der Zitatprüfung.";

/**
 * Why a requested claim was not moved.
 *
 * Only the race case exists today; the scope ladder and the reviewer-side
 * exclusions add their own reasons later. Keeping this a named union rather
 * than a free string is what lets the UI word each case instead of
 * rendering a count the reviewer cannot explain.
 */
export type RecheckExclusionReason = "raced";

export interface RecheckExclusion {
  claimId: string;
  reason: RecheckExclusionReason;
}

export interface RequestClaimRecheckInput {
  projectId: string;
  /** The claims the reviewer asked for. Modelled as a list from the start
   * so the sweep is the same call with a wider selection, not a second
   * use-case. */
  claimIds: readonly string[];
}

/**
 * A structured result, deliberately NOT the bare `string[]` that
 * `readmitStaleExistenceChecks` and `sweepSourceRecheck` return (both keep
 * theirs — this is an addition, not a migration).
 *
 * Those two are machine-initiated and report only what they did. This one
 * answers a reviewer who was shown an itemisation BEFORE pressing, and
 * therefore needs the AFTER truth as well: `string[]` cannot express
 * "five requested, three moved, two raced", and a count discrepancy the
 * reviewer cannot explain reads as data loss rather than as an exclusion.
 */
export interface RequestClaimRecheckResult {
  moved: string[];
  excluded: RecheckExclusion[];
}

export interface RequestClaimRecheckDependencies {
  runner?: JobRunner;
  /** Injected timestamp — the transitions and the bracket pair share it. */
  at?: string;
}

/**
 * Whether a claim may be pulled back into `recheck_required` right now.
 *
 * `RECHECK_STATUSES` is the single source shared with the source-revision
 * and extraction writers, and it is aligned edge-for-edge with the
 * transition table — so this predicate can never select a claim the gate
 * would then refuse.
 */
export function isRecheckEligible(claim: Claim): boolean {
  return RECHECK_STATUSES.has(claim.status);
}

/** The eligible subset of an explicit selection, in register order. */
export function selectRequestedClaims(
  register: ClaimsRegister,
  claimIds: readonly string[],
): Claim[] {
  const requested = new Set(claimIds);
  return register.claims.filter(
    (claim) => requested.has(claim.id) && isRecheckEligible(claim),
  );
}

/**
 * Reviewer-triggered re-verification (RERUN-01): moves the requested claims
 * into `recheck_required` and brackets the request in the chain. It starts
 * NO run — the reviewer's next „KI-Prüfung starten" picks the claims up
 * through the ordinary cascade, which is why the bracket closes inside the
 * same transaction that opens it.
 *
 * Idempotent by construction: `recheck_required` is not one of the eligible
 * source statuses, so a second request on the same claim selects nothing,
 * moves nothing and appends no event.
 */
export async function requestClaimRecheck(
  input: RequestClaimRecheckInput,
  deps: RequestClaimRecheckDependencies = {},
): Promise<RequestClaimRecheckResult> {
  const actor = getCurrentActor();
  const runner = deps.runner ?? getGlobalJobRunner();
  // Precondition, not an error handler: asked AFTER the transaction, the
  // refusal would arrive having already moved claims. Same pair, same
  // reason, as reviseSource and correctSourceMetadata — a run caches its
  // work set at start, so a mid-run status change is invisible to it.
  const blocking = describeBlockingActivity(input.projectId);
  if (blocking || runner.isRunning(input.projectId)) {
    throw new RunActiveError(input.projectId, blocking);
  }

  const store = requireProjectStore(input.projectId);
  const register = await store.read();
  const candidates = selectRequestedClaims(register, input.claimIds);
  if (candidates.length === 0) {
    return { moved: [], excluded: [] };
  }

  const at = deps.at ?? new Date().toISOString();
  return store.transaction((tx) => {
    const moved: string[] = [];
    const excluded: RecheckExclusion[] = [];
    for (const candidate of candidates) {
      // Re-derive under the lock: a human may have adjudicated, discarded
      // or otherwise moved one of these between the read above and this
      // transaction, and their verdict wins over a machine re-check.
      const current = tx.getClaim(candidate.id);
      if (!isRecheckEligible(current)) {
        excluded.push({ claimId: candidate.id, reason: "raced" });
        continue;
      }
      tx.transitionClaim(candidate.id, {
        to: "recheck_required",
        actor: RECHECK_ACTOR,
        reason: TRANSITION_REASON,
        at,
      });
      moved.push(candidate.id);
    }
    if (moved.length > 0) {
      // The payload is `moved`, never `input.claimIds`: the bracket must
      // describe the transitions actually made inside this transaction.
      tx.recordReverificationRun({
        claim_ids: moved,
        actor,
        started_reason:
          `Erneute Prüfung angefordert für ${moved.length} ` +
          `Aussage${moved.length === 1 ? "" : "n"}.`,
        completed_reason:
          `${moved.length} Aussage${moved.length === 1 ? "" : "n"} zur ` +
          "Nachprüfung vorgemerkt – die Prüfung selbst startet erst mit " +
          "dem nächsten Prüflauf.",
        at,
      });
    }
    return { moved, excluded };
  });
}
