import type { Claim, ClaimsRegister } from "../../../register";
import { requireProjectStore } from "../../projects";

/** A claim stuck in adjudication BECAUSE its existence check failed — the
 * same structural predicate the correction's readmission edge keys on
 * (`history.at(-1)?.routing === "existence_check_failed"`), shared so the
 * two derivations below cannot diverge. */
const strandedByExistenceCheck = (claim: Claim): boolean =>
  claim.status === "pending_adjudication" &&
  claim.history.at(-1)?.routing === "existence_check_failed";

/**
 * Sources worth an automatic repair evaluation (automatic repair): every
 * distinct source cited by evidence of a stranded claim.
 */
export function sourcesNeedingRepairEvaluation(
  register: ClaimsRegister,
): string[] {
  const sourceIds = new Set<string>();
  for (const claim of register.claims.filter(strandedByExistenceCheck)) {
    for (const evidence of claim.evidence) {
      sourceIds.add(evidence.source_id);
    }
  }
  return [...sourceIds];
}

/** Project-id variant for the auto-chain, which owns no register access of
 * its own. */
export async function sourcesNeedingRepairEvaluationForProject(
  projectId: string,
): Promise<string[]> {
  const register = await requireProjectStore(projectId).read();
  return sourcesNeedingRepairEvaluation(register);
}

/**
 * The failing verbatim excerpts those claims quote from ONE source — the
 * inputs of the quote-fit disambiguation.
 */
export function failingExcerptsForSource(
  register: ClaimsRegister,
  sourceId: string,
): string[] {
  const excerpts: string[] = [];
  for (const claim of register.claims.filter(strandedByExistenceCheck)) {
    for (const evidence of claim.evidence) {
      if (evidence.source_id === sourceId) {
        excerpts.push(evidence.verbatim_excerpt);
      }
    }
  }
  return excerpts;
}
