import { describe, expect, it } from "vitest";

import { computeProjectMetrics } from "../register";
import type { ClaimsRegister } from "../register";
import exampleProject from "../register/schema/__fixtures__/example-project.json";
import { CSV_COLUMNS, metricsToCsv } from "./metrics";

function exampleMetrics() {
  return computeProjectMetrics(
    structuredClone(exampleProject) as unknown as ClaimsRegister,
  );
}

describe("metricsToCsv", () => {
  it("writes a fixed header and one row per claim", () => {
    const csv = metricsToCsv(exampleMetrics());
    const lines = csv.trimEnd().split("\r\n");
    // EXACT equality over the COMPLETE column set, deliberately. Relaxing
    // this to a prefix, substring or regex check would stop it pinning the
    // column set at all, and a column of the RQ3 export could then change
    // meaning silently — unrecoverably, from the CSV alone. Extend the
    // literal when a column is appended; never widen the comparison.
    expect(lines[0]).toBe(
      "claim_id,status,claim_type,has_proven_evidence,support_degree," +
        "calibration_result,is_terminal_adjudicated,is_sample_control," +
        "adjudication_count,adjudication_duration_s,repair_cycles," +
        "routing_reason,is_adopted,origin_project_id," +
        "first_pass_adjudication_count,first_pass_adjudication_duration_s",
    );
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith("clm_0001,confirmed,")).toBe(true);
    // Null fields render empty, booleans render literally: is_adopted
    // false, origin_project_id null (the empty field), then the appended
    // first-pass pair, which equals the totals on a never-re-run claim.
    expect(lines[1]).toContain(",true,");
    expect(lines[1].endsWith(",false,,1,96")).toBe(true);
  });

  it("quotes fields containing separators per RFC 4180", () => {
    const metrics = exampleMetrics();
    metrics.rows[0].origin_project_id = 'proj_a,b"c\nd' as never;
    const csv = metricsToCsv(metrics);
    expect(csv).toContain('"proj_a,b""c\nd"');
  });
});

/**
 * The fourteen columns the export shipped with, transcribed by hand from
 * `metrics.ts` as it stood before reviewer-triggered re-verification. New
 * columns are APPENDED after these, so an insertion anywhere in the list
 * fails here instead of silently shifting every positional consumer of the
 * RQ3 export — including the thesis's own analysis scripts, which live in
 * the thesis repo and are not reachable from this test.
 */
const SHIPPED_CSV_COLUMNS = [
  "claim_id",
  "status",
  "claim_type",
  "has_proven_evidence",
  "support_degree",
  "calibration_result",
  "is_terminal_adjudicated",
  "is_sample_control",
  "adjudication_count",
  "adjudication_duration_s",
  "repair_cycles",
  "routing_reason",
  "is_adopted",
  "origin_project_id",
];

describe("CSV column order", () => {
  it("keeps the shipped fourteen columns in place, appending only after them", () => {
    expect(CSV_COLUMNS.slice(0, SHIPPED_CSV_COLUMNS.length)).toEqual(
      SHIPPED_CSV_COLUMNS,
    );
    // The emitted header must agree with the constant — a guard on the
    // literal alone would not catch metricsToCsv writing something else.
    expect(
      metricsToCsv(exampleMetrics())
        .split("\r\n")[0]
        .split(",")
        .slice(0, SHIPPED_CSV_COLUMNS.length),
    ).toEqual(SHIPPED_CSV_COLUMNS);
  });
});

/** Minimal history entry; chain fields are irrelevant to a pure projection
 * (the persistence layer validates them, not this test). */
function entry(
  seq: number,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    seq,
    at: "2026-08-05T09:00:00Z",
    actor: "system:calibration",
    reason: "Test.",
    prev_hash: "0".repeat(64),
    hash: "1".repeat(64),
    ...fields,
  };
}

/**
 * Puts the fixture's single claim through a reviewer-triggered re-run:
 * the request bracket, `confirmed → recheck_required`, a second stage-3
 * write that rotates the old outcome into `previous_calibrations` and
 * lands a different verdict, negative routing, and one fresh human
 * decision. This is the shape the store's `recordReverificationRun` +
 * `setCalibrationResult` pair produces; the projection under test reads
 * register data, so building that data directly is the same input.
 */
function applyRerun(register: ClaimsRegister): void {
  register.project_events.push({
    seq: 10,
    at: "2026-08-05T09:00:00Z",
    actor: "human:lg",
    event: "reverification_run_started",
    reason: "Erneute Prüfung angefordert.",
    prev_hash: "0".repeat(64),
    hash: "1".repeat(64),
    reverification_run: { claim_ids: ["clm_0001"] },
  } as never);
  const claim = register.claims[0];
  claim.previous_calibrations = [
    {
      support_degree: claim.support_degree,
      calibration_result: claim.calibration_result,
      superseded_at: "2026-08-05T09:00:00Z",
    },
  ] as never;
  claim.status = "contested";
  claim.support_degree = "partially_supported";
  claim.calibration_result = "weakened";
  (claim.history as unknown as Record<string, unknown>[]).push(
    entry(11, {
      from_status: "confirmed",
      to_status: "recheck_required",
      actor: "system:recheck_request",
    }),
    entry(12, { from_status: "recheck_required", to_status: "prechecked" }),
    entry(13, {
      from_status: "prechecked",
      to_status: "pending_adjudication",
      routing: "negative_precheck",
    }),
    entry(14, {
      from_status: "pending_adjudication",
      to_status: "contested",
      actor: "human:lg",
      decision: {
        categories: ["taken_out_of_context"],
        reviewed_evidence_ids: [],
        duration_s: 150,
      },
    }),
  );
}

/** Header-keyed view of one CSV row. The columns asserted below carry no
 * separators, so a plain split is sound here; RFC-4180 quoting has its own
 * case above. */
function csvRow(csv: string, claimId: string): Record<string, string> {
  const lines = csv.trimEnd().split("\r\n");
  const header = lines[0].split(",");
  const line = lines.slice(1).find((row) => row.startsWith(`${claimId},`));
  if (line === undefined) {
    throw new Error(`no CSV row for ${claimId}`);
  }
  const values = line.split(",");
  return Object.fromEntries(header.map((column, i) => [column, values[i]]));
}

/**
 * P-12: the frozen columns — the ones an already-published figure was read
 * from, which a re-run must therefore leave alone.
 *
 * - `claim_id`, `claim_type` — row identity. A cited row must stay joinable
 *   to the row it was cited from.
 * - `is_sample_control` — RQ3 control-group membership. A re-run must
 *   neither recruit a claim into the control group nor expel it, or the
 *   control and treatment populations shift under a published comparison.
 * - `repair_cycles` — a re-run is not a repair. Counting it as one would
 *   inflate the repair figure with re-verification effort.
 * - `is_adopted`, `origin_project_id` — warm-run provenance. Nothing about
 *   a re-run touches where the claim came from.
 * - `first_pass_adjudication_count`, `first_pass_adjudication_duration_s` —
 *   the whole point of D-09. After a re-run these still report the effort
 *   figures that `adjudication_count` / `adjudication_duration_s` reported
 *   BEFORE it, so a number already written up stays re-derivable from a
 *   later export instead of being silently re-derived.
 */
const FROZEN_COLUMNS = [
  "claim_id",
  "claim_type",
  "is_sample_control",
  "repair_cycles",
  "is_adopted",
  "origin_project_id",
  "first_pass_adjudication_count",
  "first_pass_adjudication_duration_s",
];

describe("metricsToCsv across a re-run (P-12 regression)", () => {
  it("leaves the frozen columns byte-identical while the re-run-sensitive ones move", () => {
    const register = structuredClone(
      exampleProject,
    ) as unknown as ClaimsRegister;
    const before = csvRow(
      metricsToCsv(computeProjectMetrics(register)),
      "clm_0001",
    );
    applyRerun(register);
    const after = csvRow(
      metricsToCsv(computeProjectMetrics(register)),
      "clm_0001",
    );

    // Exact string comparison per frozen column, not a row count.
    for (const column of FROZEN_COLUMNS) {
      expect([column, after[column]]).toEqual([column, before[column]]);
    }
    // And they are frozen at the PRE-re-run totals, not merely stable.
    expect(after.first_pass_adjudication_count).toBe(before.adjudication_count);
    expect(after.first_pass_adjudication_duration_s).toBe(
      before.adjudication_duration_s,
    );

    // The re-run-sensitive columns move, exactly as D-09 says they must.
    expect(before.is_terminal_adjudicated).toBe("true");
    expect(after.is_terminal_adjudicated).toBe("false");
    expect(before.calibration_result).toBe("licensed");
    expect(after.calibration_result).toBe("weakened");
    expect(before.routing_reason).toBe("spot_check");
    expect(after.routing_reason).toBe("negative_precheck");
    expect(before.adjudication_count).toBe("1");
    expect(after.adjudication_count).toBe("2");
    expect(before.adjudication_duration_s).toBe("96");
    expect(after.adjudication_duration_s).toBe("246");
  });

  it("counts the re-run in the D-16 aggregate as one changed claim", () => {
    const register = structuredClone(
      exampleProject,
    ) as unknown as ClaimsRegister;
    expect(computeProjectMetrics(register).reverification).toEqual({
      reverified_claims: 0,
      changed_result_claims: 0,
      last_run: null,
    });
    applyRerun(register);
    expect(computeProjectMetrics(register).reverification).toEqual({
      reverified_claims: 1,
      changed_result_claims: 1,
      // No verification run has followed the bracket yet, so there is no
      // „latest run" for the workbench sentence to describe. Null rather
      // than a zero pair: the bar renders on `last_run !== null`, and a
      // zero pair would be a claim that a run happened and changed nothing.
      last_run: null,
    });
  });

  it("scopes the workbench pair to the latest run, not the project lifetime (WR-02)", () => {
    // The mis-report: the bar's gate is per-run
    // (`precededByRecheck && completedAt`) while the two numbers it printed
    // were project-lifetime totals. A reviewer who re-checked 2 claims saw
    // the sentence report the 9-of-40 accumulated over three earlier
    // sessions — and if both of their 2 claims had changed, the sentence
    // would still have said 9 of 40, hiding the run's actual outcome.
    const register = structuredClone(
      exampleProject,
    ) as unknown as ClaimsRegister;
    applyRerun(register);

    // An earlier, already-reported re-check on a DIFFERENT claim: it counts
    // towards the lifetime pair and must not count towards this run's,
    // because no bracket in this run's window names it.
    const older = structuredClone(register.claims[0]);
    older.id = "clm_0002";
    older.previous_calibrations = [
      {
        support_degree: "supported",
        calibration_result: "licensed",
        superseded_at: "2026-08-01T09:00:00Z",
      },
    ] as never;
    older.calibration_result = "weakened";
    register.claims.push(older);

    // The run that carried the bracket of `applyRerun`.
    register.project_events.push(
      {
        seq: 20,
        at: "2026-08-05T10:00:00Z",
        actor: "human:lg",
        event: "verification_run_started",
        reason: "Prüflauf gestartet.",
        prev_hash: "0".repeat(64),
        hash: "1".repeat(64),
      } as never,
      {
        seq: 21,
        at: "2026-08-05T11:00:00Z",
        actor: "human:lg",
        event: "verification_run_completed",
        reason: "Prüflauf abgeschlossen.",
        prev_hash: "0".repeat(64),
        hash: "1".repeat(64),
      } as never,
    );

    const { reverification } = computeProjectMetrics(register);
    // Lifetime: both claims carry an archive, both changed.
    expect(reverification.reverified_claims).toBe(2);
    expect(reverification.changed_result_claims).toBe(2);
    // This run: only the claim its bracket named.
    expect(reverification.last_run).toEqual({
      reverified_claims: 1,
      changed_result_claims: 1,
    });
  });
});
