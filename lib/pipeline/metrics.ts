import { computeProjectMetrics } from "../register";
import type { ClaimMetricsRow, ProjectMetrics } from "../register";
import { requireProjectStore } from "./projects";

/**
 * Per-project accessor and serializations of the TMB-45 evaluation metrics.
 * The computation itself is a pure register projection
 * (lib/register/projection/metrics.ts); this module only reads the project
 * and formats — mirroring the derived-export split of TMB-41.
 */

export async function getProjectMetrics(
  projectId: string,
): Promise<ProjectMetrics> {
  return computeProjectMetrics(await requireProjectStore(projectId).read());
}

/** Fixed column order: deterministic, stable CSVs for reproducible
 * evaluation runs — never derived from Object.keys.
 *
 * New columns are APPENDED to the end and never interleaved: this is the
 * RQ3 export the thesis reports figures from, and a positional consumer
 * that survives an append breaks silently on an insert. The column-order
 * guard in `metrics.test.ts` pins the first fourteen entries in place so
 * that is a mechanical fact rather than a convention.
 *
 * Exported for that guard alone and deliberately NOT re-exported from the
 * pipeline barrel: the column order is an internal detail of this module
 * everywhere except in the test that freezes it. */
export const CSV_COLUMNS: readonly (keyof ClaimMetricsRow)[] = [
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
  // Appended (reviewer-triggered re-verification, D-09). The two totals
  // above keep their meaning; these answer "effort before the first
  // re-run" from the same row.
  "first_pass_adjudication_count",
  "first_pass_adjudication_duration_s",
];

/** RFC-4180 quoting: claim-derived fields may contain commas, quotes or
 * newlines; null renders as the empty field. */
function csvEscape(value: string | number | boolean | null): string {
  if (value === null) {
    return "";
  }
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The raw per-claim rows as CSV (header + one line per claim). */
export function metricsToCsv(metrics: ProjectMetrics): string {
  const lines = [
    CSV_COLUMNS.join(","),
    ...metrics.rows.map((row) =>
      CSV_COLUMNS.map((column) => csvEscape(row[column])).join(","),
    ),
  ];
  return `${lines.join("\r\n")}\r\n`;
}
