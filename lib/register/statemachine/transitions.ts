import type { Claim } from "../schema/claim";
import type { ClaimStatus } from "../schema/enums";

/**
 * Transition table of the claim status model. It is normative for the
 * implementation and mirrors the gates of the verification workflow in the
 * concept chapter (statuses erfasst → … → verworfen; gates route instead of
 * silently passing claims on).
 *
 * Gates are pure predicates over the ALREADY-PERSISTED claim state: the
 * pipeline must first write the underlying fact (existence result, judgment,
 * support degree) through the transaction capabilities, and the gate
 * re-derives pass/fail from that state. A caller cannot assert "the gate
 * passed" — a bug that skips writing evidence simply causes rejection here.
 */

export type GateResult = { ok: true } | { ok: false; reason: string };
export type Gate = (claim: Claim) => GateResult;

export interface TransitionDef {
  from: ClaimStatus | null;
  to: ClaimStatus;
  /** Which actor kind may take this edge. */
  actorKind: "system" | "human";
  gate: Gate;
  /** Human adjudication edges must carry a decision object; null category =
   * confirmation, non-null category = complaint. */
  decision?: "category_null" | "category_required" | "optional";
}

const ok: GateResult = { ok: true };
const fail = (reason: string): GateResult => ({ ok: false, reason });

const hasEvidence: Gate = (claim) =>
  claim.evidence.length > 0
    ? ok
    : fail("claim has no evidence (unbelegter Claim)");

const hasNoEvidence: Gate = (claim) =>
  claim.evidence.length === 0
    ? ok
    : fail("claim has evidence and belongs in erfasst");

const allExistenceChecksPassed: Gate = (claim) => {
  if (claim.evidence.length === 0) {
    return fail("claim has no evidence");
  }
  const unchecked = claim.evidence.filter(
    (evidence) => !evidence.existence_check,
  );
  if (unchecked.length > 0) {
    return fail(
      `evidence without existence check: ${unchecked.map((e) => e.id).join(", ")}`,
    );
  }
  const failed = claim.evidence.filter(
    (evidence) => evidence.existence_check?.status !== "bestanden",
  );
  return failed.length === 0
    ? ok
    : fail(`existence check failed for: ${failed.map((e) => e.id).join(", ")}`);
};

const someExistenceCheckFailed: Gate = (claim) =>
  claim.evidence.some(
    (evidence) => evidence.existence_check?.status === "nicht_bestanden",
  )
    ? ok
    : fail("no failed existence check recorded");

const preCheckComplete: Gate = (claim) => {
  const missingJudgments = claim.evidence.filter(
    (evidence) => evidence.judgments.length === 0,
  );
  if (missingJudgments.length > 0) {
    return fail(
      `evidence without judgments (Stufe 2 incomplete): ${missingJudgments
        .map((e) => e.id)
        .join(", ")}`,
    );
  }
  const unresolved = claim.evidence.filter(
    (evidence) => !evidence.relation_type,
  );
  if (unresolved.length > 0) {
    return fail(
      `evidence without resolved relation: ${unresolved.map((e) => e.id).join(", ")}`,
    );
  }
  if (!claim.support_degree) {
    return fail("support_degree not set (Stufe 2 incomplete)");
  }
  if (!claim.calibration_result) {
    return fail("calibration_result not set (Stufe 3 incomplete)");
  }
  return ok;
};

/**
 * The divergence rule compares the CURRENT position of each backend: only
 * the latest judgment per backend counts (judgments accumulate and are never
 * overwritten, so a backend revising its own earlier judgment — e.g. after a
 * repair re-run — must not read as divergence).
 */
function hasBackendDivergence(claim: Claim): boolean {
  return claim.evidence.some((evidence) => {
    const latestByBackend = new Map<string, { at: string; relation: string }>();
    for (const judgment of evidence.judgments) {
      const current = latestByBackend.get(judgment.backend);
      // Later array position wins ties, matching append order.
      if (!current || judgment.at >= current.at) {
        latestByBackend.set(judgment.backend, {
          at: judgment.at,
          relation: judgment.relation_type,
        });
      }
    }
    return (
      new Set([...latestByBackend.values()].map((entry) => entry.relation))
        .size > 1
    );
  });
}

const autoConfirmable: Gate = (claim) => {
  if (claim.support_degree !== "supported") {
    return fail(
      `support_degree is ${claim.support_degree ?? "unset"}, not supported`,
    );
  }
  if (claim.calibration_result !== "lizenziert") {
    return fail(
      `calibration_result is ${claim.calibration_result ?? "unset"}, not lizenziert (Rubrik)`,
    );
  }
  if (hasBackendDivergence(claim)) {
    return fail("backend judgments diverge (Divergenzregel)");
  }
  return ok;
};

const notAutoConfirmable: Gate = (claim) =>
  autoConfirmable(claim).ok
    ? fail("claim qualifies for automatic confirmation, not adjudication")
    : ok;

const always: Gate = () => ok;

/**
 * All edges of the status model. Terminal states: bestaetigt and verworfen
 * (no outgoing edges). automatisch_bestaetigt is not fully terminal — the
 * configurable sample draw (Stichprobe) pulls claims back to adjudication;
 * the selection itself is pipeline logic, the edge only checks the shape.
 */
export const TRANSITIONS: TransitionDef[] = [
  // Creation: the extraction gate of Nachweisvollständigkeit. Claims without
  // an extractable Fundstelle become visible in adjudication, not dropped.
  { from: null, to: "erfasst", actorKind: "system", gate: hasEvidence },
  {
    from: null,
    to: "zur_adjudikation",
    actorKind: "system",
    gate: hasNoEvidence,
  },
  // Stage 1: deterministic existence check.
  {
    from: "erfasst",
    to: "existenzgeprueft",
    actorKind: "system",
    gate: allExistenceChecksPassed,
  },
  {
    from: "erfasst",
    to: "zur_adjudikation",
    actorKind: "system",
    gate: someExistenceCheckFailed,
  },
  // Stages 2+3 complete: judgments, resolved relations and support degree set.
  {
    from: "existenzgeprueft",
    to: "vorgeprueft",
    actorKind: "system",
    gate: preCheckComplete,
  },
  // Adapter-failure escalation (TMB-19, ratified 06.08.2026): stage-2/3 LLM
  // calls that exhaust their bounded retries would otherwise leave the claim
  // stuck in existenzgeprueft. Escalation to adjudication replaces silent
  // dropping; the reason of the history entry documents the failure. The
  // gate only checks shape — WHEN the edge is taken is the caller's
  // (pipeline/job runner) decision, mirroring the sample-draw edge.
  {
    from: "existenzgeprueft",
    to: "zur_adjudikation",
    actorKind: "system",
    gate: always,
  },
  // Adjudication gate after pre-checking.
  {
    from: "vorgeprueft",
    to: "automatisch_bestaetigt",
    actorKind: "system",
    gate: autoConfirmable,
  },
  {
    from: "vorgeprueft",
    to: "zur_adjudikation",
    actorKind: "system",
    gate: notAutoConfirmable,
  },
  // Sample control of automatically confirmed claims (RQ3).
  {
    from: "automatisch_bestaetigt",
    to: "zur_adjudikation",
    actorKind: "system",
    gate: always,
  },
  // Binding human adjudication.
  {
    from: "zur_adjudikation",
    to: "bestaetigt",
    actorKind: "human",
    gate: always,
    decision: "category_null",
  },
  // Discarding is deliberately NOT possible directly from adjudication: the
  // concept routes every negative decision through beanstandet (repair is
  // offered first); verworfen is reached only from the repair loop.
  {
    from: "zur_adjudikation",
    to: "beanstandet",
    actorKind: "human",
    gate: always,
    decision: "category_required",
  },
  // Repair loop: revised version re-enters the affected stages only.
  {
    from: "beanstandet",
    to: "ueberarbeitet",
    actorKind: "system",
    gate: always,
  },
  {
    from: "beanstandet",
    to: "ueberarbeitet",
    actorKind: "human",
    gate: always,
  },
  {
    from: "beanstandet",
    to: "verworfen",
    actorKind: "human",
    gate: always,
    decision: "optional",
  },
  // Re-entry: full cascade, or skip stage 1 when the wording was merely
  // weakened (existing existence checks still pass), or escalate after
  // repeated repair failure.
  {
    from: "ueberarbeitet",
    to: "erfasst",
    actorKind: "system",
    gate: hasEvidence,
  },
  {
    from: "ueberarbeitet",
    to: "existenzgeprueft",
    actorKind: "system",
    gate: allExistenceChecksPassed,
  },
  {
    from: "ueberarbeitet",
    to: "zur_adjudikation",
    actorKind: "system",
    gate: always,
  },
];

export function findTransition(
  from: ClaimStatus | null,
  to: ClaimStatus,
  actorKind: "system" | "human",
): TransitionDef | undefined {
  return TRANSITIONS.find(
    (def) => def.from === from && def.to === to && def.actorKind === actorKind,
  );
}

/** True if any edge (regardless of actor kind) connects from → to. */
export function edgeExists(from: ClaimStatus | null, to: ClaimStatus): boolean {
  return TRANSITIONS.some((def) => def.from === from && def.to === to);
}
