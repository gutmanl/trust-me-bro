import type { RelationType, SupportDegree } from "../../register";

/**
 * Deterministic aggregation of a claim's resolved evidence relations into
 * the four-level support degree (SemanticCite scheme) — a pure rule instead
 * of a further LLM call, so identical judgments always aggregate
 * identically. Contradicting evidence stays visible as its own relation;
 * aggregation only routes:
 *
 *   widerspricht + nothing supporting  -> unsupported
 *   widerspricht + something supporting -> uncertain (conflict)
 *   no widerspricht, any stuetzt_teilweise -> partially_supported
 *   no widerspricht, at least one stuetzt  -> supported
 *   only nicht_einschlaegig (or empty)     -> unsupported
 *
 * Callers must pass one relation per evidence and only once ALL evidence of
 * the claim has a resolved relation (mirrors the preCheckComplete gate).
 */
export function aggregateSupportDegree(
  resolvedRelations: readonly RelationType[],
): SupportDegree {
  const contradicts = resolvedRelations.includes("widerspricht");
  const supports = resolvedRelations.some(
    (relation) => relation === "stuetzt" || relation === "stuetzt_teilweise",
  );
  if (contradicts) {
    return supports ? "uncertain" : "unsupported";
  }
  if (resolvedRelations.includes("stuetzt_teilweise")) {
    return "partially_supported";
  }
  if (resolvedRelations.includes("stuetzt")) {
    return "supported";
  }
  return "unsupported";
}
