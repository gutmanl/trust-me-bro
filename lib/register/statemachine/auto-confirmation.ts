import type { Claim } from "../schema/claim";
import { latestJudgmentPerBackend } from "./divergence";
import type { GateResult } from "./transitions";

/**
 * The auto-confirmation predicate of the adjudication gate, extracted as a
 * pure function so the verification pipeline can decide WHICH edge to take
 * (automatisch_bestaetigt vs. zur_adjudikation) without re-implementing the
 * rule; the transition gate itself remains the sole authority at commit
 * time. The reason string is phrased for reuse in transition reasons.
 */
export function evaluateAutoConfirmation(claim: Claim): GateResult {
  if (claim.support_degree !== "supported") {
    return {
      ok: false,
      reason: `support_degree is ${claim.support_degree ?? "unset"}, not supported`,
    };
  }
  if (claim.calibration_result !== "lizenziert") {
    return {
      ok: false,
      reason: `calibration_result is ${claim.calibration_result ?? "unset"}, not lizenziert (Rubrik)`,
    };
  }
  const divergent = claim.evidence.some((evidence) => {
    const latest = latestJudgmentPerBackend(evidence.judgments);
    return (
      new Set([...latest.values()].map((judgment) => judgment.relation_type))
        .size > 1
    );
  });
  if (divergent) {
    return { ok: false, reason: "backend judgments diverge (Divergenzregel)" };
  }
  return { ok: true };
}
