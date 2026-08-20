import type { RoutingReason } from "@/lib/register";
import type { Verdict } from "../../verdict-labels";

/** German labels of the structured routing reasons (TMB-36 queue). */
export const ROUTING_LABELS: Record<RoutingReason, string> = {
  no_evidence: "ohne Beleg erfasst",
  existence_check_failed: "Zitatprüfung nicht bestanden",
  divergence: "Backend-Urteile widersprüchlich",
  negative_precheck: "negative Vorprüfung",
  spot_check: "Stichprobe",
  escalated: "eskaliert",
  negative_relevance: "Relevanz (Folgeprojekt) negativ/unsicher",
};

/**
 * True when the routing chip would only restate the verdict chip beside it,
 * so the card should render the verdict alone.
 *
 * Exactly two of the seven reasons qualify, and the allowlist is deliberate
 * rather than a rule over the label strings:
 *
 * - `divergence` renders the byte-identical German phrase by construction —
 *   the pipeline sets it in the same transition that leaves
 *   support_degree/calibration_result unset, which is precisely the shape
 *   deriveVerdict answers with its divergence branch. Two chips, one word
 *   for word identical statement.
 * - `negative_precheck` is the coarse restatement of whichever specific
 *   phrase the support × calibration matrix already produced ("stützt
 *   nicht", "stützt nicht in diesem Ausmaß", …). The verdict chip is
 *   strictly more informative.
 *
 * The other five stay: `spot_check` is the ONLY badge explaining why a
 * positively-judged claim sits in the adjudication queue at all — suppress
 * it and a green card looks queued for no reason — and `escalated`,
 * `negative_relevance`, `no_evidence` and `existence_check_failed` are
 * likewise unrecoverable from any other badge on the card.
 *
 * Gated on a verdict actually being present: with `verdict === null` no chip
 * is rendered to supersede anything, so suppressing here would delete the
 * reviewer's only routing signal.
 */
export function routingSupersededByVerdict(
  routing: RoutingReason,
  verdict: Verdict | null,
): boolean {
  return (
    verdict !== null &&
    (routing === "divergence" || routing === "negative_precheck")
  );
}
