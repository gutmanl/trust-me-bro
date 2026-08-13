import type { CalibrationResult, SupportDegree } from "@/lib/register";

/**
 * Combined pre-check verdict (verdict redesign): one intuitive German
 * phrase derived from support_degree × calibration_result, so a reviewer
 * reads a single judgment instead of reconciling two enum rows. The raw
 * enum values (SUPPORT_LABELS/CALIBRATION_LABELS) stay available in the
 * expanded detail — this module never replaces those maps.
 */

export type VerdictSeverity = "green" | "amber" | "orange" | "red" | "slate";

export interface Verdict {
  phrase: string;
  severity: VerdictSeverity;
}

export function verdictBadgeClassName(severity: VerdictSeverity): string {
  switch (severity) {
    case "green":
      return "bg-green-100 text-green-800";
    case "amber":
      return "bg-amber-100 text-amber-800";
    case "orange":
      return "bg-orange-100 text-orange-800";
    case "red":
      return "bg-red-100 text-red-800";
    case "slate":
      return "bg-slate-100 text-slate-600";
  }
}

/** Severity chip per evidence relation, matching the verdict palette. */
export function relationBadgeClassName(
  relation: "supports" | "partially_supports" | "contradicts" | "not_relevant",
): string {
  switch (relation) {
    case "supports":
      return "bg-green-100 text-green-800";
    case "partially_supports":
      return "bg-amber-100 text-amber-800";
    case "contradicts":
      return "bg-red-100 text-red-800";
    case "not_relevant":
      return "bg-slate-100 text-slate-600";
  }
}

const VERDICT_MATRIX: Record<
  SupportDegree,
  Record<CalibrationResult, Verdict>
> = {
  supported: {
    licensed: { phrase: "stützt", severity: "green" },
    weakened: {
      phrase: "stützt, aber zu stark formuliert",
      severity: "amber",
    },
    pending_adjudication: {
      phrase: "stützt, Kalibrierung unklar",
      severity: "orange",
    },
  },
  partially_supported: {
    licensed: { phrase: "stützt teilweise", severity: "amber" },
    weakened: {
      phrase: "stützt nicht in diesem Ausmaß",
      severity: "orange",
    },
    pending_adjudication: {
      phrase: "stützt teilweise, Kalibrierung unklar",
      severity: "orange",
    },
  },
  uncertain: {
    licensed: {
      phrase: "unklar – Belege widersprechen sich",
      severity: "orange",
    },
    weakened: {
      phrase: "unklar und zu stark formuliert",
      severity: "red",
    },
    pending_adjudication: { phrase: "unklar", severity: "orange" },
  },
  unsupported: {
    // unsupported + licensed is unreachable through the pipeline (zero
    // pertinent sources always fails the mechanical minimum, which caps
    // licensed down to weakened) — modeled anyway so the Record stays
    // exhaustive and a data anomaly still renders honestly.
    licensed: { phrase: "stützt nicht", severity: "red" },
    weakened: { phrase: "stützt nicht", severity: "red" },
    pending_adjudication: {
      phrase: "stützt nicht, Kalibrierung unklar",
      severity: "red",
    },
  },
};

/**
 * null = nothing to show (the pre-check has not produced a verdict: claim
 * not yet through stages 2/3). Divergence is its own branch, detected by
 * the caller from the evidence-level judgment disagreement, because on
 * divergence both enums stay unset by construction.
 */
export function deriveVerdict(
  supportDegree: SupportDegree | undefined,
  calibrationResult: CalibrationResult | undefined,
  divergent: boolean,
): Verdict | null {
  if (divergent) {
    return { phrase: "Backend-Urteile widersprüchlich", severity: "red" };
  }
  if (supportDegree === undefined && calibrationResult === undefined) {
    return null;
  }
  if (supportDegree === undefined || calibrationResult === undefined) {
    // Pipeline invariant: applyPreCheckResult sets both together or
    // neither — reachable only via hand-edited data. Degrade visibly.
    return { phrase: "Vorprüfung unvollständig", severity: "slate" };
  }
  return VERDICT_MATRIX[supportDegree][calibrationResult];
}
