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
 * Evaluation metrics (TMB-45, A5): Nachweisvollständigkeit,
 * Nachweiskorrektheit and Prüfaufwand, computed EXCLUSIVELY from the
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
  /** ≥1 Fundstelle proven in the frozen corpus (existence check passed). */
  has_proven_fundstelle: boolean;
  support_degree: SupportDegree | null;
  calibration_result: string | null;
  /** Human-final outcome (bestaetigt or verworfen). */
  is_terminal_adjudicated: boolean;
  /** ≥1 of the claim's adjudication decisions followed a sample draw
   * (RQ3 control, reported separately). */
  is_sample_control: boolean;
  /** Human decisions recorded on this claim (history entries carrying a
   * decision object). */
  adjudication_count: number;
  /** Summed decision.duration_s over all decisions of this claim. */
  adjudication_duration_s: number;
  repair_cycles: number;
  /** Last routing reason INTO zur_adjudikation, if any. */
  routing_reason: RoutingReason | null;
  /** Warm-run adoption (TMB-43). */
  is_adopted: boolean;
  origin_project_id: string | null;
}

export interface ProjectMetrics {
  project_id: string;
  source_set_revision: number;
  nachweisvollstaendigkeit: {
    total_claims: number;
    with_proven_fundstelle: number;
    /** 0 when the project has no claims. */
    ratio: number;
  };
  /** Support-degree distribution after adjudication: claims with a
   * human-final outcome (bestaetigt/verworfen); `unassessed` counts those
   * without a support degree (e.g. discarded before pre-checking). */
  nachweiskorrektheit: {
    total_terminal: number;
    by_support_degree: Record<SupportDegree | "unassessed", number>;
  };
  /** Adjudication effort WITHOUT the sample-control decisions, which the
   * `stichprobe` block reports separately (RQ3). */
  pruefaufwand: {
    total_decisions: number;
    total_duration_s: number;
    mean_duration_s: number;
    total_repair_cycles: number;
  };
  stichprobe: {
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
    routed_relevanz_negativ: number;
  } | null;
  rows: ClaimMetricsRow[];
}

/** A decision entry belongs to the sample control iff the last routing
 * into zur_adjudikation BEFORE it was the sample draw. */
function isSampleDecision(claim: Claim, decisionEntry: HistoryEntry): boolean {
  const routingBefore = claim.history
    .filter(
      (entry) =>
        entry.seq < decisionEntry.seq && entry.to_status === "zur_adjudikation",
    )
    .at(-1);
  return routingBefore?.routing === "stichprobe";
}

function buildRow(claim: Claim): ClaimMetricsRow {
  const decisions = claim.history.filter(
    (entry) => entry.decision !== undefined,
  );
  const sampleDecisions = decisions.filter((entry) =>
    isSampleDecision(claim, entry),
  );
  const lastRouting = claim.history
    .filter((entry) => entry.to_status === "zur_adjudikation")
    .at(-1);
  return {
    claim_id: claim.id,
    status: claim.status,
    claim_type: claim.claim_type,
    has_proven_fundstelle: claim.evidence.some(
      (evidence) => evidence.existence_check?.status === "bestanden",
    ),
    support_degree: claim.support_degree ?? null,
    calibration_result: claim.calibration_result ?? null,
    is_terminal_adjudicated:
      claim.status === "bestaetigt" || claim.status === "verworfen",
    is_sample_control: sampleDecisions.length > 0,
    adjudication_count: decisions.length,
    adjudication_duration_s: decisions.reduce(
      (sum, entry) => sum + (entry.decision?.duration_s ?? 0),
      0,
    ),
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
  const rows = register.claims.map(buildRow);

  const withProven = rows.filter((row) => row.has_proven_fundstelle).length;

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

  const adopted = rows.filter((row) => row.is_adopted);
  const routedNegativ = register.claims.filter((claim) =>
    claim.history.some((entry) => entry.routing === "einschlaegigkeit_negativ"),
  ).length;

  return {
    project_id: register.project.id,
    source_set_revision: register.project.source_set_revision,
    nachweisvollstaendigkeit: {
      total_claims: rows.length,
      with_proven_fundstelle: withProven,
      ratio: rows.length === 0 ? 0 : withProven / rows.length,
    },
    nachweiskorrektheit: {
      total_terminal: terminal.length,
      by_support_degree: bySupportDegree,
    },
    pruefaufwand: {
      total_decisions: regularDecisions,
      total_duration_s: regularDurationS,
      mean_duration_s:
        regularDecisions === 0 ? 0 : regularDurationS / regularDecisions,
      total_repair_cycles: rows.reduce(
        (sum, row) => sum + row.repair_cycles,
        0,
      ),
    },
    stichprobe: {
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
                row.status === "bestaetigt" ||
                row.status === "automatisch_bestaetigt" ||
                row.status === "verworfen",
            ).length,
            routed_relevanz_negativ: routedNegativ,
          },
    rows,
  };
}
