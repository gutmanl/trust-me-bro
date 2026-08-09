import { describe, expect, it } from "vitest";

import exampleProject from "../schema/__fixtures__/example-project.json";
import type { ClaimsRegister } from "../schema/register";
import { computeProjectMetrics } from "./metrics";

function baseRegister(): ClaimsRegister {
  return structuredClone(exampleProject) as unknown as ClaimsRegister;
}

/** Minimal history entry shell; chain fields are irrelevant to the pure
 * derivation (they are validated by the persistence layer, not here). */
function entry(
  seq: number,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    seq,
    at: "2026-08-01T10:00:00Z",
    actor: "system:test",
    reason: "Test.",
    prev_hash: "0".repeat(64),
    hash: "1".repeat(64),
    ...fields,
  };
}

describe("computeProjectMetrics", () => {
  it("returns zeroed aggregates for a claimless register", () => {
    const register = baseRegister();
    register.claims = [];
    const metrics = computeProjectMetrics(register);
    expect(metrics.evidence_completeness).toEqual({
      total_claims: 0,
      with_proven_evidence: 0,
      ratio: 0,
    });
    expect(metrics.evidence_correctness.total_terminal).toBe(0);
    expect(metrics.review_effort.total_decisions).toBe(0);
    expect(metrics.review_effort.mean_duration_s).toBe(0);
    expect(metrics.spot_check.total_decisions).toBe(0);
    expect(metrics.warm_run).toBeNull();
    expect(metrics.rows).toEqual([]);
  });

  it("derives the appendix example: one confirmed claim via sample control", () => {
    const metrics = computeProjectMetrics(baseRegister());
    expect(metrics.evidence_completeness).toEqual({
      total_claims: 1,
      with_proven_evidence: 1,
      ratio: 1,
    });
    expect(metrics.evidence_correctness.total_terminal).toBe(1);
    expect(metrics.evidence_correctness.by_support_degree.supported).toBe(1);
    // The single decision followed the sample draw — it counts as RQ3
    // control, NOT as regular adjudication effort.
    expect(metrics.review_effort.total_decisions).toBe(0);
    expect(metrics.review_effort.total_duration_s).toBe(0);
    expect(metrics.spot_check.total_decisions).toBe(1);
    expect(metrics.spot_check.total_duration_s).toBe(96);
    expect(metrics.spot_check.claim_ids).toEqual(["clm_0001"]);
    const row = metrics.rows[0];
    expect(row.is_sample_control).toBe(true);
    expect(row.is_terminal_adjudicated).toBe(true);
    expect(row.routing_reason).toBe("spot_check");
    expect(row.is_adopted).toBe(false);
  });

  it("separates regular effort, counts repair cycles and warm-run reuse", () => {
    const register = baseRegister();
    const template = structuredClone(register.claims[0]);
    // Regular adjudication: routed by negative pre-check, two decisions
    // (complaint + confirmation after repair), one repair cycle.
    const regular = structuredClone(template);
    regular.id = "clm_0002";
    regular.status = "confirmed";
    regular.support_degree = "partially_supported";
    regular.history = [
      entry(20, { from_status: null, to_status: "captured" }),
      entry(21, {
        from_status: "prechecked",
        to_status: "pending_adjudication",
        routing: "negative_precheck",
      }),
      entry(22, {
        from_status: "pending_adjudication",
        to_status: "contested",
        actor: "human:lg",
        decision: {
          categories: ["taken_out_of_context"],
          reviewed_evidence_ids: [],
          duration_s: 120,
        },
      }),
      entry(23, {
        from_status: "contested",
        to_status: "revised",
        revision: { previous_text: "Alt.", new_text: "Neu." },
      }),
      entry(24, {
        from_status: "revised",
        to_status: "pending_adjudication",
        routing: "escalated",
      }),
      entry(25, {
        from_status: "pending_adjudication",
        to_status: "confirmed",
        actor: "human:lg",
        decision: {
          categories: [],
          reviewed_evidence_ids: [],
          duration_s: 60,
        },
      }),
    ] as never;
    // Adopted claim (warm run) later routed for negative relevance.
    const adopted = structuredClone(template);
    adopted.id = "clm_0003";
    adopted.status = "pending_adjudication";
    adopted.provenance = {
      ...adopted.provenance,
      origin_project_id: "proj_ursprung",
    };
    adopted.history = [
      entry(30, { from_status: null, to_status: "confirmed" }),
      entry(31, {
        from_status: "confirmed",
        to_status: "pending_adjudication",
        routing: "negative_relevance",
      }),
    ] as never;
    // Adopted claim that stayed settled.
    const adoptedKept = structuredClone(template);
    adoptedKept.id = "clm_0004";
    adoptedKept.status = "auto_confirmed";
    adoptedKept.provenance = {
      ...adoptedKept.provenance,
      origin_project_id: "proj_ursprung",
    };
    adoptedKept.history = [
      entry(32, { from_status: null, to_status: "auto_confirmed" }),
    ] as never;
    register.claims.push(regular, adopted, adoptedKept);

    const metrics = computeProjectMetrics(register);
    expect(metrics.review_effort.total_decisions).toBe(2);
    expect(metrics.review_effort.total_duration_s).toBe(180);
    expect(metrics.review_effort.mean_duration_s).toBe(90);
    expect(metrics.review_effort.total_repair_cycles).toBe(1);
    // The fixture claim's sample decision stays separate.
    expect(metrics.spot_check.total_decisions).toBe(1);
    expect(metrics.warm_run).toEqual({
      adopted_total: 2,
      origin_project_ids: ["proj_ursprung"],
      still_settled: 1,
      routed_negative_relevance: 1,
    });
    const regularRow = metrics.rows.find((row) => row.claim_id === "clm_0002");
    expect(regularRow?.adjudication_count).toBe(2);
    expect(regularRow?.adjudication_duration_s).toBe(180);
    expect(regularRow?.repair_cycles).toBe(1);
    expect(regularRow?.is_sample_control).toBe(false);
    expect(regularRow?.routing_reason).toBe("escalated");
    const adoptedRow = metrics.rows.find((row) => row.claim_id === "clm_0003");
    expect(adoptedRow?.is_adopted).toBe(true);
    expect(adoptedRow?.routing_reason).toBe("negative_relevance");
  });
});
