import type { Claim, ClaimsRegister, Source } from "../../register";
import type { ClaimType, SourceType } from "../../register";
import type { ClaimTypeRule, MechanicalViolation } from "./rubric-rules";
import {
  evaluateMechanicalViolations,
  loadRubricRuleSet,
} from "./rubric-rules";

/**
 * Why a claim's verdict is mechanically capped (verdict-driven repair): the
 * rule the project's pinned rubric applies to this claim type, which of its
 * conditions the claim's PERSISTED pertinent sources violate, and the
 * counts a reader needs to see required-vs-actual. Derived, never stored —
 * the run discards the mechanical outcome after applying the cap, and
 * everything needed to re-derive it (evidence relations, source types, the
 * pinned rule set) is already durable.
 */
export interface MechanicalCapVM {
  claimType: ClaimType;
  rule: ClaimTypeRule;
  violations: MechanicalViolation[];
  /** Distinct sources whose persisted relation supports the claim. */
  pertinentSources: number;
  pertinentTypes: SourceType[];
}

/** The persisted twin of the run-time pertinent-source derivation: reads
 * `evidence.relation_type` as the register holds it (the resolved relation
 * the run wrote), where the run-time variant reads this run's fresh
 * resolutions. One entry per distinct source, not per evidence. */
function persistedPertinentSourceTypes(
  claim: Claim,
  sourcesById: ReadonlyMap<string, Source>,
): SourceType[] {
  const pertinentSources = new Set(
    claim.evidence
      .filter(
        (evidence) =>
          evidence.relation_type === "supports" ||
          evidence.relation_type === "partially_supports",
      )
      .map((evidence) => evidence.source_id),
  );
  return [...pertinentSources]
    .map((sourceId) => sourcesById.get(sourceId)?.custom.source_type)
    .filter((type): type is SourceType => type !== undefined);
}

/**
 * The mechanical caps of a register, keyed by claim id: present exactly for
 * claims that carry a pre-check verdict AND whose persisted pertinent
 * sources violate the pinned rule set — the claims whose `weakened` no
 * wording repair can ever lift. An unresolvable rubric pin yields an empty
 * map rather than an error, mirroring `loadRecheckPreview`'s tolerance: a
 * config problem must not take the project page down, and "no cap shown"
 * is the honest degraded answer.
 */
export function deriveMechanicalCaps(
  register: ClaimsRegister,
): Record<string, MechanicalCapVM> {
  let ruleSet: ReturnType<typeof loadRubricRuleSet>;
  try {
    ruleSet = loadRubricRuleSet(register.config.rubric_version);
  } catch {
    return {};
  }
  const sourcesById = new Map(
    register.sources.map((source) => [source.id, source]),
  );
  const caps: Record<string, MechanicalCapVM> = {};
  for (const claim of register.claims) {
    if (claim.calibration_result === undefined) {
      continue;
    }
    const rule = ruleSet.claim_types[claim.claim_type];
    if (rule === undefined) {
      continue;
    }
    const pertinentTypes = persistedPertinentSourceTypes(claim, sourcesById);
    const violations = evaluateMechanicalViolations(pertinentTypes, rule);
    if (violations.length === 0) {
      continue;
    }
    caps[claim.id] = {
      claimType: claim.claim_type,
      rule,
      violations,
      pertinentSources: pertinentTypes.length,
      pertinentTypes,
    };
  }
  return caps;
}
