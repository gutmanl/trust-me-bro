import type { Orchestrator, RepairOutput } from "../../adapters";
import { loadAdapterConfig } from "../../identity";
import type {
  CalibrationResult,
  Claim,
  ClaimsRegister,
  SupportDegree,
} from "../../register";
import { DEFAULT_SECOND_OPINION } from "../projects";
import type { RubricRuleSet } from "../verification/rubric-rules";
import { loadRubricRuleSet } from "../verification/rubric-rules";
import { runAttributionAndRubric } from "../verification/stage2/attribution-rubric";

/**
 * Generation-time counter-check of a repair proposal (scrutiny loop): the
 * verdict stages 2/3 would assign the SUGGESTED wording against the
 * existing evidence — computed BEFORE the suggestion is recorded, so the
 * loop can regenerate instead of shipping a proposal that verification
 * would immediately park again.
 *
 * A forecast, not the verification protocol: primary backend only (no
 * second opinion, so no divergence), nothing persisted, no claim touched.
 * The rule set, prompt vintages and calibration combinator are the SAME
 * ones a later re-verification will use (`runAttributionAndRubric`), which
 * is what makes the forecast meaningful.
 */

export interface ScrutinyVerdict {
  calibrationResult: CalibrationResult;
  supportDegree: SupportDegree;
  reasoning: string;
}

export type ScrutinyOutcome =
  | { status: "ok"; verdict: ScrutinyVerdict }
  /** The check could not run to a verdict (backend paused/exhausted,
   * unresolvable rubric pin). Says nothing about the proposal's quality. */
  | { status: "unavailable"; reason: string };

export async function scrutinizeSuggestion(
  register: ClaimsRegister,
  projectDir: string,
  orchestrator: Orchestrator,
  claim: Claim,
  proposal: RepairOutput,
): Promise<ScrutinyOutcome> {
  let ruleSet: RubricRuleSet;
  try {
    ruleSet = loadRubricRuleSet(register.config.rubric_version);
  } catch (error) {
    return {
      status: "unavailable",
      reason: `rubric rule set unresolvable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // The hypothetical claim the stages judge: the proposed wording over the
  // claim's own evidence. Corrected excerpts substitute the failed ones —
  // the applied repair will persist exactly those. Existing judgments are
  // EMPTIED: they judged the old wording, and `resolveEvidenceRelation`
  // folds every judgment it sees into the relation.
  const correctedExcerpts = new Map(
    (proposal.evidence_repairs ?? []).map((repair) => [
      repair.evidence_id,
      repair.corrected_excerpt,
    ]),
  );
  const hypothetical: Claim = {
    ...claim,
    text: proposal.suggested_text,
    evidence: claim.evidence.map((evidence) => ({
      ...evidence,
      verbatim_excerpt:
        correctedExcerpts.get(evidence.id) ?? evidence.verbatim_excerpt,
      judgments: [],
    })),
  };

  const outcome = await runAttributionAndRubric(
    hypothetical,
    new Map(register.sources.map((source) => [source.id, source])),
    {
      orchestrator,
      primaryBackendId: register.config.backends.primary.cli,
      projectDir,
      timeoutMs: loadAdapterConfig().timeoutMs,
      // Irrelevant without a secondary backend, but the dependency is
      // required — resolved the same way the verification run resolves it.
      secondOpinion: register.config.second_opinion ?? DEFAULT_SECOND_OPINION,
      rubricVersion: register.config.rubric_version,
      ruleSet,
    },
  );
  if (outcome.status === "paused") {
    return {
      status: "unavailable",
      reason: `backend paused: ${outcome.reason}`,
    };
  }
  if (outcome.status === "exhausted") {
    return { status: "unavailable", reason: outcome.message };
  }
  if (outcome.supportDegree === null || outcome.calibration === null) {
    // Structurally unreachable with a single backend and emptied judgments
    // (divergence needs two backends); guarded so a future change degrades
    // to "no forecast" instead of a crash.
    return { status: "unavailable", reason: "relation unresolved" };
  }
  return {
    status: "ok",
    verdict: {
      calibrationResult: outcome.calibration.result,
      supportDegree: outcome.supportDegree,
      reasoning: outcome.calibration.reasoning,
    },
  };
}
