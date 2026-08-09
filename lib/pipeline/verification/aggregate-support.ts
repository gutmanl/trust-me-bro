import type { RelationType, SupportDegree } from "../../register";

/**
 * Deterministic aggregation of a claim's resolved evidence relations into
 * the four-level support degree (SemanticCite scheme) — a pure rule instead
 * of a further LLM call, so identical judgments always aggregate
 * identically. Contradicting evidence stays visible as its own relation;
 * aggregation only routes:
 *
 *   contradicts + nothing supporting  -> unsupported
 *   contradicts + something supporting -> uncertain (conflict)
 *   no contradicts, any partially_supports -> partially_supported
 *   no contradicts, at least one supports  -> supported
 *   only not_relevant (or empty)     -> unsupported
 *
 * Callers must pass one relation per evidence and only once ALL evidence of
 * the claim has a resolved relation (mirrors the preCheckComplete gate).
 */
export function aggregateSupportDegree(
  resolvedRelations: readonly RelationType[],
): SupportDegree {
  const contradicts = resolvedRelations.includes("contradicts");
  const supports = resolvedRelations.some(
    (relation) => relation === "supports" || relation === "partially_supports",
  );
  if (contradicts) {
    return supports ? "uncertain" : "unsupported";
  }
  if (resolvedRelations.includes("partially_supports")) {
    return "partially_supported";
  }
  if (resolvedRelations.includes("supports")) {
    return "supported";
  }
  return "unsupported";
}
