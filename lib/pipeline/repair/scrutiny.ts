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
 * A forecast, not a verification run: nothing persisted, no claim
 * touched. Everything else mirrors the real protocol — rule set, prompt
 * vintages, calibration combinator AND the second-opinion/divergence rule
 * with the configured secondary backend (`runAttributionAndRubric`). The
 * mirroring is the point: an earlier primary-only variant licensed
 * wordings the real re-run then parked as "Backend-Urteile
 * widersprüchlich".
 */

export interface ScrutinyVerdict {
  calibrationResult: CalibrationResult;
  supportDegree: SupportDegree;
  reasoning: string;
}

export type ScrutinyOutcome =
  | { status: "ok"; verdict: ScrutinyVerdict }
  /** The two backends disagreed on an evidence relation for the proposed
   * wording — the situation the real run routes to the human. The loop
   * treats it as a rejection: an ambiguous wording is exactly what a
   * reformulation can fix. */
  | { status: "diverged" }
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
      ...(register.config.backends.secondary !== undefined
        ? { secondaryBackendId: register.config.backends.secondary.cli }
        : {}),
      projectDir,
      timeoutMs: loadAdapterConfig().timeoutMs,
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
    // The two backends disagreed on at least one relation — exactly what
    // the real run would park for the human ("Backend-Urteile
    // widersprüchlich").
    return { status: "diverged" };
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
