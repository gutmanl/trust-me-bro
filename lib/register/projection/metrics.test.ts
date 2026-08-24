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

/** Minimal project-event shell for a re-run bracket; only `seq`, `event`
 * and the carried `claim_ids` are load-bearing for the projection. */
function rerunStarted(
  seq: number,
  claimIds: string[],
): Record<string, unknown> {
  return {
    seq,
    at: "2026-08-02T10:00:00Z",
    actor: "human:lg",
    event: "reverification_run_started",
    reason: "Erneute Prüfung angefordert.",
    prev_hash: "0".repeat(64),
    hash: "1".repeat(64),
    reverification_run: { claim_ids: claimIds },
  };
}

/** A decision-carrying history entry at a given seq. */
function decisionEntry(seq: number, durationS: number) {
  return entry(seq, {
    from_status: "pending_adjudication",
    to_status: "contested",
    actor: "human:lg",
    decision: {
      categories: [],
      reviewed_evidence_ids: [],
      duration_s: durationS,
    },
  });
}

/** A claim cloned off the fixture, with a hand-written history. */
function claimWith(
  register: ClaimsRegister,
  id: string,
  history: Record<string, unknown>[],
): ClaimsRegister["claims"][number] {
  const claim = structuredClone(register.claims[0]);
  claim.id = id;
  claim.history = history as never;
  return claim;
}

function rowOf(register: ClaimsRegister, claimId: string) {
  const row = computeProjectMetrics(register).rows.find(
    (candidate) => candidate.claim_id === claimId,
  );
  if (!row) {
    throw new Error(`no row for ${claimId}`);
  }
  return row;
}

describe("computeProjectMetrics: first-pass counterparts (D-09)", () => {
  it("equals the totals exactly for a claim that was never re-run", () => {
    const register = baseRegister();
    register.claims = [
      claimWith(register, "clm_0010", [
        entry(40, { from_status: null, to_status: "captured" }),
        decisionEntry(41, 30),
        decisionEntry(42, 70),
      ]),
    ];
    const row = rowOf(register, "clm_0010");
    // Strict equality, not merely "both non-zero": the whole point of the
    // pair is that a never-re-run claim reports the same figure twice.
    expect(row.adjudication_count).toBe(2);
    expect(row.first_pass_adjudication_count).toBe(row.adjudication_count);
    expect(row.adjudication_duration_s).toBe(100);
    expect(row.first_pass_adjudication_duration_s).toBe(
      row.adjudication_duration_s,
    );
  });

  it("counts only the decisions before the bracket when a re-run split the history", () => {
    const register = baseRegister();
    register.claims = [
      claimWith(register, "clm_0011", [
        entry(40, { from_status: null, to_status: "captured" }),
        decisionEntry(41, 30),
        decisionEntry(42, 70),
        // seq 50 is the bracket.
        decisionEntry(51, 200),
      ]),
    ];
    register.project_events.push(rerunStarted(50, ["clm_0011"]) as never);
    const row = rowOf(register, "clm_0011");
    expect(row.adjudication_count).toBe(3);
    expect(row.adjudication_duration_s).toBe(300);
    expect(row.first_pass_adjudication_count).toBe(2);
    expect(row.first_pass_adjudication_duration_s).toBe(100);
  });

  it("equals the totals for a re-run claim whose decisions all precede the bracket", () => {
    const register = baseRegister();
    register.claims = [
      claimWith(register, "clm_0012", [
        entry(40, { from_status: null, to_status: "captured" }),
        decisionEntry(41, 45),
      ]),
    ];
    register.project_events.push(rerunStarted(50, ["clm_0012"]) as never);
    const row = rowOf(register, "clm_0012");
    expect(row.first_pass_adjudication_count).toBe(row.adjudication_count);
    expect(row.first_pass_adjudication_duration_s).toBe(
      row.adjudication_duration_s,
    );
    expect(row.first_pass_adjudication_count).toBe(1);
  });

  it("uses the EARLIEST bracket when two name the same claim", () => {
    const register = baseRegister();
    register.claims = [
      claimWith(register, "clm_0013", [
        entry(40, { from_status: null, to_status: "captured" }),
        decisionEntry(41, 10),
        // Between the two brackets: excluded, because the window is fixed
        // by the FIRST re-run and a later sweep must not widen it.
        decisionEntry(61, 500),
        decisionEntry(71, 700),
      ]),
    ];
    // Deliberately pushed out of order, so a passing test cannot be an
    // artefact of "the last bracket seen happens to be the earliest".
    register.project_events.push(rerunStarted(70, ["clm_0013"]) as never);
    register.project_events.push(rerunStarted(50, ["clm_0013"]) as never);
    const row = rowOf(register, "clm_0013");
    expect(row.adjudication_count).toBe(3);
    expect(row.adjudication_duration_s).toBe(1210);
    expect(row.first_pass_adjudication_count).toBe(1);
    expect(row.first_pass_adjudication_duration_s).toBe(10);
  });

  it("ignores a bracket event that carries no claim ids", () => {
    const register = baseRegister();
    register.claims = [
      claimWith(register, "clm_0016", [
        entry(40, { from_status: null, to_status: "captured" }),
        decisionEntry(51, 90),
      ]),
    ];
    const bracket = rerunStarted(50, []);
    delete bracket.reverification_run;
    register.project_events.push(bracket as never);
    // The payload is schema-OPTIONAL. A bracket without it must leave the
    // claim unwindowed rather than throw or silently window it to zero —
    // a zero first-pass figure is a claim about the data, not an absence.
    expect(rowOf(register, "clm_0016").first_pass_adjudication_count).toBe(1);
  });

  it("windows only the claims the bracket names", () => {
    const register = baseRegister();
    register.claims = [
      claimWith(register, "clm_0014", [
        entry(40, { from_status: null, to_status: "captured" }),
        decisionEntry(51, 90),
      ]),
      claimWith(register, "clm_0015", [
        entry(40, { from_status: null, to_status: "captured" }),
        decisionEntry(51, 90),
      ]),
    ];
    register.project_events.push(rerunStarted(50, ["clm_0014"]) as never);
    expect(rowOf(register, "clm_0014").first_pass_adjudication_count).toBe(0);
    expect(rowOf(register, "clm_0015").first_pass_adjudication_count).toBe(1);
  });
});

describe("computeProjectMetrics: the re-run aggregate (D-16)", () => {
  it("reads 0 and 0 on a register with no archived pre-check at all", () => {
    const metrics = computeProjectMetrics(baseRegister());
    expect(metrics.reverification.reverified_claims).toBe(0);
    expect(metrics.reverification.changed_result_claims).toBe(0);
  });

  it("counts as changed only the claims whose NEWEST archived result differs", () => {
    const register = baseRegister();
    const archived = (result: string, at: string) => ({
      calibration_result: result,
      superseded_at: at,
    });
    const changed = claimWith(register, "clm_0020", [
      entry(40, { from_status: null, to_status: "prechecked" }),
    ]);
    changed.calibration_result = "weakened";
    changed.previous_calibrations = [
      archived("licensed", "2026-08-02T10:00:00Z"),
    ] as never;
    const unchanged = claimWith(register, "clm_0021", [
      entry(40, { from_status: null, to_status: "prechecked" }),
    ]);
    unchanged.calibration_result = "licensed";
    unchanged.previous_calibrations = [
      archived("licensed", "2026-08-02T10:00:00Z"),
    ] as never;
    // Moved and moved back: the NEWEST archived entry agrees with the
    // current result, so this claim is re-verified but not changed — the
    // same judgment the per-claim note makes on the card.
    const movedBack = claimWith(register, "clm_0022", [
      entry(40, { from_status: null, to_status: "prechecked" }),
    ]);
    movedBack.calibration_result = "licensed";
    movedBack.previous_calibrations = [
      archived("licensed", "2026-08-02T10:00:00Z"),
      archived("weakened", "2026-08-03T10:00:00Z"),
      archived("licensed", "2026-08-04T10:00:00Z"),
    ] as never;
    register.claims = [changed, unchanged, movedBack];

    const metrics = computeProjectMetrics(register);
    expect(metrics.reverification.reverified_claims).toBe(3);
    expect(metrics.reverification.changed_result_claims).toBe(1);
  });

  it("ignores an empty archive array", () => {
    const register = baseRegister();
    const claim = claimWith(register, "clm_0023", [
      entry(40, { from_status: null, to_status: "prechecked" }),
    ]);
    claim.previous_calibrations = [];
    register.claims = [claim];
    expect(
      computeProjectMetrics(register).reverification.reverified_claims,
    ).toBe(0);
  });

  it("is idempotent: two calls over the same register are deep-equal", () => {
    const register = baseRegister();
    const claim = claimWith(register, "clm_0024", [
      entry(40, { from_status: null, to_status: "prechecked" }),
      decisionEntry(51, 60),
    ]);
    claim.calibration_result = "weakened";
    claim.previous_calibrations = [
      { calibration_result: "licensed", superseded_at: "2026-08-02T10:00:00Z" },
    ] as never;
    register.claims = [claim];
    register.project_events.push(rerunStarted(50, ["clm_0024"]) as never);
    expect(computeProjectMetrics(register)).toEqual(
      computeProjectMetrics(register),
    );
  });
});
