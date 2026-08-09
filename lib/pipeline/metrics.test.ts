import { describe, expect, it } from "vitest";

import { computeProjectMetrics } from "../register";
import type { ClaimsRegister } from "../register";
import exampleProject from "../register/schema/__fixtures__/example-project.json";
import { metricsToCsv } from "./metrics";

function exampleMetrics() {
  return computeProjectMetrics(
    structuredClone(exampleProject) as unknown as ClaimsRegister,
  );
}

describe("metricsToCsv", () => {
  it("writes a fixed header and one row per claim", () => {
    const csv = metricsToCsv(exampleMetrics());
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "claim_id,status,claim_type,has_proven_evidence,support_degree," +
        "calibration_result,is_terminal_adjudicated,is_sample_control," +
        "adjudication_count,adjudication_duration_s,repair_cycles," +
        "routing_reason,is_adopted,origin_project_id",
    );
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith("clm_0001,confirmed,")).toBe(true);
    // Null fields render empty, booleans render literally.
    expect(lines[1]).toContain(",true,");
    expect(lines[1].endsWith(",false,")).toBe(true);
  });

  it("quotes fields containing separators per RFC 4180", () => {
    const metrics = exampleMetrics();
    metrics.rows[0].origin_project_id = 'proj_a,b"c\nd' as never;
    const csv = metricsToCsv(metrics);
    expect(csv).toContain('"proj_a,b""c\nd"');
  });
});
