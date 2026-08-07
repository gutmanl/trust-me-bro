import type { Judgment, SecondOpinionConfig } from "../../register";

/**
 * Second-opinion trigger of the Divergenzregel (TMB-29): the secondary
 * backend is asked when the PRIMARY judgment is contentious — confidence
 * below the threshold, or (when enabled) a relation other than `stuetzt`.
 * Evaluated once against the primary judgment only; the secondary's own
 * confidence is never re-evaluated recursively.
 */
export function needsSecondOpinion(
  judgment: Pick<Judgment, "relation_type" | "confidence">,
  config: SecondOpinionConfig,
): boolean {
  if (judgment.confidence < config.confidence_threshold) {
    return true;
  }
  return config.on_relation_not_stuetzt && judgment.relation_type !== "stuetzt";
}
