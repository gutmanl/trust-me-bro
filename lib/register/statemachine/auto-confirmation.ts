import type { Claim } from "../schema/claim";
import {
  judgmentsForCurrentWording,
  latestJudgmentPerBackend,
} from "./divergence";
import type { GateResult } from "./transitions";

/**
 * The auto-confirmation predicate of the adjudication gate, extracted as a
 * pure function so the verification pipeline can decide WHICH edge to take
 * (auto_confirmed vs. pending_adjudication) without re-implementing the
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
  if (claim.calibration_result !== "licensed") {
    return {
      ok: false,
      reason: `calibration_result is ${claim.calibration_result ?? "unset"}, not licensed (rubric)`,
    };
  }
  const divergent = claim.evidence.some((evidence) => {
    // Superseded-wording judgments are excluded here for the same reason
    // the pipeline excludes them when resolving the relation — see
    // `judgmentsForCurrentWording`.
    const latest = latestJudgmentPerBackend(
      judgmentsForCurrentWording(claim, evidence.judgments),
    );
    return (
      new Set([...latest.values()].map((judgment) => judgment.relation_type))
        .size > 1
    );
  });
  if (divergent) {
    return { ok: false, reason: "backend judgments diverge (divergence rule)" };
  }
  return { ok: true };
}
