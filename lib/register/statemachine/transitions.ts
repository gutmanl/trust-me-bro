import type { Claim } from "../schema/claim";
import type { ClaimStatus } from "../schema/enums";
import { isAtomicClaimText } from "./atomicity";
import { evaluateAutoConfirmation } from "./auto-confirmation";

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
  /** Human adjudication edges must carry a decision object; an empty
   * `categories` array = confirmation, a non-empty one = complaint. The
   * literal names predate the multi-select extension (TMB-35) and are kept
   * to leave the pinned edge table untouched. */
  decision?: "category_null" | "category_required" | "optional";
}

const ok: GateResult = { ok: true };
const fail = (reason: string): GateResult => ({ ok: false, reason });

/**
 * Admission into "erfasst" (creation and repair re-entry): evidence must
 * exist (Fundstellen-Gate) AND the wording must be one atomic statement
 * (Atomaritäts-Gate, TMB-25). Both violations route to adjudication —
 * visible, never dropped.
 */
const hasEvidence: Gate = (claim) => {
  if (claim.evidence.length === 0) {
    return fail("claim has no evidence (unbelegter Claim)");
  }
  if (!isAtomicClaimText(claim.text)) {
    return fail("claim text bundles multiple statements (Atomaritätsgate)");
  }
  return ok;
};

const hasNoEvidence: Gate = (claim) =>
  claim.evidence.length === 0 || !isAtomicClaimText(claim.text)
    ? ok
    : fail("claim has evidence and belongs in erfasst");

/**
 * Exported (like evaluateAutoConfirmation) so the repair pipeline can decide
 * WHICH re-entry edge a revised claim takes without re-implementing the
 * rule; the gate in the table remains the authority at commit time.
 */
export const allExistenceChecksPassed: Gate = (claim) => {
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
 * The auto-confirmation rule (supported + lizenziert + no divergence among
 * the latest judgments per backend) lives in auto-confirmation.ts so the
 * verification pipeline can consult the same predicate; this gate remains
 * the authority at commit time.
 */
const autoConfirmable: Gate = (claim) => evaluateAutoConfirmation(claim);

const notAutoConfirmable: Gate = (claim) =>
  autoConfirmable(claim).ok
    ? fail("claim qualifies for automatic confirmation, not adjudication")
    : ok;

const always: Gate = () => ok;

/**
 * Adoption edges of the warm run (TMB-43) are only takeable by claims that
 * actually carry adoption provenance — a structural, self-enforcing check:
 * normal extraction can never mint a pre-confirmed claim because its claims
 * have no origin project.
 */
const isAdopted: Gate = (claim) =>
  claim.provenance.origin_project_id !== undefined
    ? ok
    : fail("adoption edge requires provenance.origin_project_id (Warmlauf)");

/**
 * All edges of the status model. Since TMB-7 only verworfen is fully
 * terminal (no outgoing edges): bestaetigt and automatisch_bestaetigt are
 * settled, not eternal — a source revision (TMB-44) or a negative relevance
 * judgment of a warm run (TMB-43) reopens them via narrowly-scoped
 * system-only edges. The sample draw (Stichprobe) pulls
 * automatisch_bestaetigt claims back to adjudication as before; selection
 * logic is pipeline work, the edges only check the shape.
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
  // Warm-run adoption (TMB-43, ratified with the TMB-7 epic): an adopted
  // claim is CREATED into its settled origin status — it was never
  // "erfasst, ungeprüft" in this project, it arrives fully verified from
  // the origin project (referenced in provenance.origin_project_id, which
  // the gate enforces). This is the one sanctioned exception to the rule
  // that claims start in erfasst or zur_adjudikation.
  { from: null, to: "bestaetigt", actorKind: "system", gate: isAdopted },
  {
    from: null,
    to: "automatisch_bestaetigt",
    actorKind: "system",
    gate: isAdopted,
  },
  { from: null, to: "verworfen", actorKind: "system", gate: isAdopted },
  // Relevance check of the warm run (TMB-43): a negative/uncertain
  // Einschlägigkeit judgment re-routes an adopted, previously human-confirmed
  // claim to adjudication (routing einschlaegigkeit_negativ) — the human
  // stays the final instance on whether the claim counts for the new
  // question. automatisch_bestaetigt reuses its existing sample-draw edge.
  {
    from: "bestaetigt",
    to: "zur_adjudikation",
    actorKind: "system",
    gate: isAdopted,
  },
  // Bestandsrevision (TMB-44): a source revision invalidates the machine
  // determinations that referenced the old wording. Exactly the settled
  // statuses are pulled back: erfasst self-heals (stage 1 always re-runs),
  // zur_adjudikation/beanstandet/ueberarbeitet are mid human-workflow and
  // stay untouched (the revision event is visible in the history), and
  // verworfen stays terminal — a discard is not revived by new source text.
  // WHEN these edges are taken is the revision use-case's decision,
  // mirroring the sample-draw edge.
  {
    from: "existenzgeprueft",
    to: "nachpruefung_erforderlich",
    actorKind: "system",
    gate: always,
  },
  {
    from: "vorgeprueft",
    to: "nachpruefung_erforderlich",
    actorKind: "system",
    gate: always,
  },
  {
    from: "automatisch_bestaetigt",
    to: "nachpruefung_erforderlich",
    actorKind: "system",
    gate: always,
  },
  {
    from: "bestaetigt",
    to: "nachpruefung_erforderlich",
    actorKind: "system",
    gate: always,
  },
  // Re-entry after Nachprüfung: always the full cascade from stage 1 —
  // the revised source text can invalidate any stage's determination, and
  // reusing the existing cascade needs zero new pipeline logic.
  {
    from: "nachpruefung_erforderlich",
    to: "erfasst",
    actorKind: "system",
    gate: hasEvidence,
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
