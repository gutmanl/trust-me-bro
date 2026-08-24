import type { Claim } from "../schema/claim";
import type {
  ClaimStatus,
  ClaimType,
  RoutingReason,
  SupportDegree,
} from "../schema/enums";
import type { HistoryEntry } from "../schema/history";
import type { ClaimsRegister } from "../schema/register";
import { countRepairCycles } from "./counts";

/**
 * Evaluation metrics (TMB-45, A5): evidence completeness, evidence
 * correctness and review effort, computed EXCLUSIVELY from the
 * register's history — deliberately never persisted, a stored second copy
 * could drift from the chain it summarizes. All functions are pure over
 * ClaimsRegister and testable with the fixture registers.
 */

/** One raw per-claim row — the export contains these, not just aggregates
 * (TMB-45 acceptance criterion). */
export interface ClaimMetricsRow {
  claim_id: string;
  status: ClaimStatus;
  claim_type: ClaimType;
  /** ≥1 piece of evidence proven in the frozen corpus (existence check
   * passed). */
  has_proven_evidence: boolean;
  support_degree: SupportDegree | null;
  calibration_result: string | null;
  /** Human-final outcome (confirmed or discarded). */
  is_terminal_adjudicated: boolean;
  /** ≥1 of the claim's adjudication decisions followed a sample draw
   * (RQ3 control, reported separately). */
  is_sample_control: boolean;
  /** Human decisions recorded on this claim (history entries carrying a
   * decision object). Unchanged by reviewer-triggered re-verification: it
   * still counts EVERY decision on the claim, including those made after a
   * re-run (D-09). */
  adjudication_count: number;
  /** Summed decision.duration_s over all decisions of this claim — the
   * total, never a windowed subset (D-09). */
  adjudication_duration_s: number;
  /** `adjudication_count` restricted to the decisions recorded BEFORE the
   * claim's first `reverification_run_started` bracket (reviewer-triggered
   * re-verification). Equal to `adjudication_count` for a claim that was
   * never re-run and less than or equal to it otherwise; the difference is
   * exactly the effort the re-run caused. The pair exists so the RQ3 export
   * answers both "total effort" and "effort before the first re-run"
   * without either field having to change meaning — figures already written
   * up from an earlier export stay comparable (D-09, documented extension,
   * additive). */
  first_pass_adjudication_count: number;
  /** `adjudication_duration_s` over the same pre-re-run window as
   * `first_pass_adjudication_count`, with the same equal-when-never-re-run
   * property (D-09, documented extension, additive). */
  first_pass_adjudication_duration_s: number;
  repair_cycles: number;
  /** Last routing reason INTO pending_adjudication, if any. */
  routing_reason: RoutingReason | null;
  /** Warm-run adoption (TMB-43). */
  is_adopted: boolean;
  origin_project_id: string | null;
}

export interface ProjectMetrics {
  project_id: string;
  source_set_revision: number;
  evidence_completeness: {
    total_claims: number;
    with_proven_evidence: number;
    /** 0 when the project has no claims. */
    ratio: number;
  };
  /** Support-degree distribution after adjudication: claims with a
   * human-final outcome (confirmed/discarded); `unassessed` counts those
   * without a support degree (e.g. discarded before pre-checking). */
  evidence_correctness: {
    total_terminal: number;
    by_support_degree: Record<SupportDegree | "unassessed", number>;
  };
  /** Adjudication effort WITHOUT the sample-control decisions, which the
   * `spot_check` block reports separately (RQ3). */
  review_effort: {
    total_decisions: number;
    total_duration_s: number;
    mean_duration_s: number;
    total_repair_cycles: number;
  };
  spot_check: {
    total_decisions: number;
    total_duration_s: number;
    claim_ids: string[];
  };
  /** Warm-run reuse (TMB-43): raw counts a cold/warm effort comparison is
   * computed from; null when the project adopted nothing. */
  warm_run: {
    adopted_total: number;
    origin_project_ids: string[];
    still_settled: number;
    routed_negative_relevance: number;
  } | null;
  /** Reviewer-triggered re-verification (D-16). A pure projection over
   * `previous_calibrations`, recomputed at every call like everything else
   * in this module and deliberately never persisted.
   *
   * Two ABSOLUTE counts and no ratio, on purpose: a rate here would be read
   * as an agreement or accuracy rate, and the run-to-run verdict flip floor
   * measured in Phase 03 (borderline corpus, identical templates, no prompt
   * change at all) makes that reading false. Do not add a `ratio` field and
   * do not divide these two in a caller. */
  reverification: {
    /** M — claims carrying at least one archived pre-check outcome, i.e.
     * claims whose pre-check has been redone at least once. */
    reverified_claims: number;
    /** N — of those, the ones whose NEWEST archived `calibration_result`
     * differs from the current one. Compared as enum values, never as
     * rendered German labels. */
    changed_result_claims: number;
  };
  rows: ClaimMetricsRow[];
}

/** A decision entry belongs to the sample control iff the last routing
 * into pending_adjudication BEFORE it was the sample draw. */
function isSampleDecision(claim: Claim, decisionEntry: HistoryEntry): boolean {
  const routingBefore = claim.history
    .filter(
      (entry) =>
        entry.seq < decisionEntry.seq &&
        entry.to_status === "pending_adjudication",
    )
    .at(-1);
  return routingBefore?.routing === "spot_check";
}

/**
 * The `seq` of the EARLIEST `reverification_run_started` event naming each
 * claim — the boundary D-09's first-pass counterparts are windowed by.
 *
 * Built once here rather than inside `buildRow`, which sees only a `Claim`
 * and therefore cannot reach `register.project_events` at all. The bracket
 * carries its `claim_ids` explicitly (D-12) precisely so this map does not
 * have to be reconstructed from a seq window resting on a single-writer
 * invariant nothing enforces. The EARLIEST bracket wins, so a later sweep
 * can never shift a window that is already established.
 */
function buildFirstRerunSeqByClaimId(
  register: ClaimsRegister,
): ReadonlyMap<string, number> {
  const firstRerunSeq = new Map<string, number>();
  for (const event of register.project_events) {
    if (event.event !== "reverification_run_started") {
      continue;
    }
    for (const claimId of event.reverification_run?.claim_ids ?? []) {
      const known = firstRerunSeq.get(claimId);
      if (known === undefined || event.seq < known) {
        firstRerunSeq.set(claimId, event.seq);
      }
    }
  }
  return firstRerunSeq;
}

function sumDurationS(entries: readonly HistoryEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + (entry.decision?.duration_s ?? 0),
    0,
  );
}

function buildRow(
  claim: Claim,
  firstRerunSeqByClaimId: ReadonlyMap<string, number>,
): ClaimMetricsRow {
  const decisions = claim.history.filter(
    (entry) => entry.decision !== undefined,
  );
  const firstRerunSeq = firstRerunSeqByClaimId.get(claim.id);
  // No bracket names this claim: the first pass IS the whole history, so the
  // counterparts equal the totals rather than reading zero.
  const firstPassDecisions =
    firstRerunSeq === undefined
      ? decisions
      : decisions.filter((entry) => entry.seq < firstRerunSeq);
  const sampleDecisions = decisions.filter((entry) =>
    isSampleDecision(claim, entry),
  );
  const lastRouting = claim.history
    .filter((entry) => entry.to_status === "pending_adjudication")
    .at(-1);
  return {
    claim_id: claim.id,
    status: claim.status,
    claim_type: claim.claim_type,
    has_proven_evidence: claim.evidence.some(
      (evidence) => evidence.existence_check?.status === "passed",
    ),
    support_degree: claim.support_degree ?? null,
    calibration_result: claim.calibration_result ?? null,
    is_terminal_adjudicated:
      claim.status === "confirmed" || claim.status === "discarded",
    is_sample_control: sampleDecisions.length > 0,
    adjudication_count: decisions.length,
    adjudication_duration_s: sumDurationS(decisions),
    first_pass_adjudication_count: firstPassDecisions.length,
    first_pass_adjudication_duration_s: sumDurationS(firstPassDecisions),
    repair_cycles: countRepairCycles(claim),
    routing_reason: lastRouting?.routing ?? null,
    is_adopted: claim.provenance.origin_project_id !== undefined,
    origin_project_id: claim.provenance.origin_project_id ?? null,
  };
}

const SUPPORT_DEGREES: readonly SupportDegree[] = [
  "supported",
  "partially_supported",
  "unsupported",
  "uncertain",
];

export function computeProjectMetrics(
  register: ClaimsRegister,
): ProjectMetrics {
  const firstRerunSeqByClaimId = buildFirstRerunSeqByClaimId(register);
  const rows = register.claims.map((claim) =>
    buildRow(claim, firstRerunSeqByClaimId),
  );

  const withProven = rows.filter((row) => row.has_proven_evidence).length;

  const terminal = rows.filter((row) => row.is_terminal_adjudicated);
  const bySupportDegree = Object.fromEntries([
    ...SUPPORT_DEGREES.map((degree) => [
      degree,
      terminal.filter((row) => row.support_degree === degree).length,
    ]),
    [
      "unassessed",
      terminal.filter((row) => row.support_degree === null).length,
    ],
  ]) as Record<SupportDegree | "unassessed", number>;

  // Effort split per DECISION entry (not per claim): a claim can carry both
  // a regular and a sample-control decision across its lifetime.
  let regularDecisions = 0;
  let regularDurationS = 0;
  let sampleDecisions = 0;
  let sampleDurationS = 0;
  const sampleClaimIds: string[] = [];
  for (const claim of register.claims) {
    let claimHasSample = false;
    for (const entry of claim.history) {
      if (!entry.decision) {
        continue;
      }
      if (isSampleDecision(claim, entry)) {
        sampleDecisions += 1;
        sampleDurationS += entry.decision.duration_s;
        claimHasSample = true;
      } else {
        regularDecisions += 1;
        regularDurationS += entry.decision.duration_s;
      }
    }
    if (claimHasSample) {
      sampleClaimIds.push(claim.id);
    }
  }

  // D-16: counts, never a rate. A claim is "re-verified" iff it carries an
  // archived pre-check outcome; it "changed" iff the NEWEST archived
  // calibration_result differs from the current one. Enum comparison only.
  let reverifiedClaims = 0;
  let changedResultClaims = 0;
  for (const claim of register.claims) {
    const newestArchived = claim.previous_calibrations?.at(-1);
    if (newestArchived === undefined) {
      continue;
    }
    reverifiedClaims += 1;
    if (newestArchived.calibration_result !== claim.calibration_result) {
      changedResultClaims += 1;
    }
  }

  const adopted = rows.filter((row) => row.is_adopted);
  const routedNegative = register.claims.filter((claim) =>
    claim.history.some((entry) => entry.routing === "negative_relevance"),
  ).length;

  return {
    project_id: register.project.id,
    source_set_revision: register.project.source_set_revision,
    evidence_completeness: {
      total_claims: rows.length,
      with_proven_evidence: withProven,
      ratio: rows.length === 0 ? 0 : withProven / rows.length,
    },
    evidence_correctness: {
      total_terminal: terminal.length,
      by_support_degree: bySupportDegree,
    },
    review_effort: {
      total_decisions: regularDecisions,
      total_duration_s: regularDurationS,
      mean_duration_s:
        regularDecisions === 0 ? 0 : regularDurationS / regularDecisions,
      total_repair_cycles: rows.reduce(
        (sum, row) => sum + row.repair_cycles,
        0,
      ),
    },
    spot_check: {
      total_decisions: sampleDecisions,
      total_duration_s: sampleDurationS,
      claim_ids: sampleClaimIds,
    },
    warm_run:
      adopted.length === 0
        ? null
        : {
            adopted_total: adopted.length,
            origin_project_ids: [
              ...new Set(adopted.map((row) => row.origin_project_id as string)),
            ].sort(),
            still_settled: adopted.filter(
              (row) =>
                row.status === "confirmed" ||
                row.status === "auto_confirmed" ||
                row.status === "discarded",
            ).length,
            routed_negative_relevance: routedNegative,
          },
    reverification: {
      reverified_claims: reverifiedClaims,
      changed_result_claims: changedResultClaims,
    },
    rows,
  };
}
