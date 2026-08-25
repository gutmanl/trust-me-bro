import type { Orchestrator } from "../../../adapters";
import { renderPromptForJob } from "../../../adapters";
import type {
  AttributionInput,
  EvidenceContext,
  JobRequest,
  RubricInput,
  StampedOutput,
} from "../../../adapters";
import type {
  CalibrationResult,
  Claim,
  Judgment,
  RelationType,
  SecondOpinionConfig,
  Source,
  SourceType,
  SupportDegree,
} from "../../../register";
import {
  judgmentsForCurrentWording,
  resolveEvidenceRelation,
} from "../../../register";
import { aggregateSupportDegree } from "../aggregate-support";
import type { RubricRuleSet } from "../rubric-rules";
import {
  combineCalibrationResult,
  evaluateMechanicalRubric,
} from "../rubric-rules";
import { resolvePersistedReasoning } from "../reasoning-join";
import { needsSecondOpinion } from "../second-opinion";

/**
 * Stages 2+3 for one claim (TMB-28/29/31), pure information gathering — no
 * register access, everything the transaction later persists is returned.
 * Per evidence the primary backend judges the attribution; contentious
 * primary judgments (second-opinion criteria) get the secondary backend's
 * judgment appended. Divergence between the latest judgments per backend
 * leaves the relation unresolved (adjudication decides) but the loop
 * CONTINUES so all judgments become visible. Only a fully resolved claim
 * reaches the rubric job (stage 3); its verdict is capped by the mechanical
 * rule check. The first paused/exhausted orchestrator outcome aborts
 * immediately: nothing of this pass is persisted, the claim is retried
 * whole on the next run.
 */

export interface EvidenceJudgingResult {
  evidenceId: string;
  newJudgments: Judgment[];
  /** Resolved over existing + new judgments; null on divergence. */
  resolvedRelation: RelationType | null;
}

export interface Stage23Ok {
  status: "ok";
  perEvidence: EvidenceJudgingResult[];
  /** null exactly when some evidence stayed unresolved (divergence). */
  supportDegree: SupportDegree | null;
  /** null exactly when supportDegree is null (rubric job skipped). */
  calibration: {
    result: CalibrationResult;
    reasoning: string;
    mechanical: "met" | "not_met";
  } | null;
}

export type Stage23Outcome =
  | Stage23Ok
  | { status: "paused"; reason: string }
  | { status: "exhausted"; message: string };

export interface Stage23Dependencies {
  orchestrator: Orchestrator;
  primaryBackendId: string;
  secondaryBackendId?: string;
  projectDir: string;
  timeoutMs: number;
  /** Resolved config (project setting or code default); only consulted when
   * a secondary backend exists. */
  secondOpinion: SecondOpinionConfig;
  rubricVersion: string;
  ruleSet: RubricRuleSet;
}

export async function runAttributionAndRubric(
  claim: Claim,
  sourcesById: ReadonlyMap<string, Source>,
  deps: Stage23Dependencies,
): Promise<Stage23Outcome> {
  const claimContext = {
    id: claim.id,
    text: claim.text,
    claim_type: claim.claim_type,
    briefing_anchor: claim.briefing_anchor,
  };
  const evidenceContext = (
    evidence: Claim["evidence"][number],
  ): EvidenceContext => {
    const source = sourcesById.get(evidence.source_id);
    if (!source) {
      // Referential integrity of the register makes this unreachable.
      throw new Error(`unknown source ${evidence.source_id} on ${claim.id}`);
    }
    return {
      id: evidence.id,
      source_id: evidence.source_id,
      source_type: source.custom.source_type,
      locator: evidence.locator,
      verbatim_excerpt: evidence.verbatim_excerpt,
    };
  };

  const perEvidence: EvidenceJudgingResult[] = [];
  for (const evidence of claim.evidence) {
    const input: AttributionInput = {
      claim: claimContext,
      evidence: evidenceContext(evidence),
    };
    const primary = await runAttribution(deps, deps.primaryBackendId, input);
    if (primary.status !== "ok") {
      return primary;
    }
    const newJudgments: Judgment[] = [primary.judgment];
    if (
      deps.secondaryBackendId &&
      needsSecondOpinion(primary.judgment, deps.secondOpinion)
    ) {
      const second = await runAttribution(deps, deps.secondaryBackendId, input);
      if (second.status !== "ok") {
        return second;
      }
      newJudgments.push(second.judgment);
    }
    perEvidence.push({
      evidenceId: evidence.id,
      newJudgments,
      resolvedRelation: resolveEvidenceRelation([
        // Judgments of a superseded wording do not count (phantom
        // divergence after repairs) — see `judgmentsForCurrentWording`.
        ...judgmentsForCurrentWording(claim, evidence.judgments),
        ...newJudgments,
      ]),
    });
  }

  const resolved = perEvidence.map((entry) => entry.resolvedRelation);
  if (resolved.some((relation) => relation === null)) {
    return {
      status: "ok",
      perEvidence,
      supportDegree: null,
      calibration: null,
    };
  }
  const supportDegree = aggregateSupportDegree(resolved as RelationType[]);

  // Stage 3: mechanical rule check over the DISTINCT pertinent sources plus
  // the LLM's semantic verdict; the mechanical result caps the proposal.
  const pertinentTypes = pertinentSourceTypes(claim, perEvidence, sourcesById);
  const rule = deps.ruleSet.claim_types[claim.claim_type];
  const mechanical = rule
    ? evaluateMechanicalRubric(pertinentTypes, rule)
    : "met";
  const rubricInput: RubricInput = {
    claim: claimContext,
    evidence: claim.evidence.map(evidenceContext),
    rubric_version: deps.rubricVersion,
  };
  const rubricJob: JobRequest<"rubric"> = {
    kind: "rubric",
    projectDir: deps.projectDir,
    input: rubricInput,
    // The rule set decides which prompt template version renders — an
    // existing project pinned to se-evidence-rubric-v1 keeps the v1.0.0
    // prompt; new projects (v1.1 rule set) get the two-paragraph one.
    prompt: renderPromptForJob(
      "rubric",
      rubricInput,
      deps.ruleSet.prompt_template_version,
    ),
    timeoutMs: deps.timeoutMs,
  };
  const outcome = await deps.orchestrator.run(deps.primaryBackendId, rubricJob);
  if (outcome.status === "paused") {
    return { status: "paused", reason: outcome.reason };
  }
  if (outcome.status === "exhausted") {
    return {
      status: "exhausted",
      message: `Bewertung erschöpft: ${outcome.lastError.message}`,
    };
  }
  return {
    status: "ok",
    perEvidence,
    supportDegree,
    calibration: {
      result: combineCalibrationResult(
        mechanical,
        outcome.output.calibration_result,
      ),
      // The PIPELINE owns the persisted string, not the model: a v1.2.0
      // rubric answer is joined here, a v1.0.0/v1.1.0 one is handed back
      // byte-for-byte. Same line, both vintages.
      reasoning: resolvePersistedReasoning(outcome.output),
      mechanical,
    },
  };
}

async function runAttribution(
  deps: Stage23Dependencies,
  backendId: string,
  input: AttributionInput,
): Promise<
  | { status: "ok"; judgment: Judgment }
  | { status: "paused"; reason: string }
  | { status: "exhausted"; message: string }
> {
  const job: JobRequest<"attribution"> = {
    kind: "attribution",
    projectDir: deps.projectDir,
    input,
    // The rule set decides which prompt template version renders, exactly as
    // it does for the rubric job above — read through `deps.ruleSet` rather
    // than hoisted onto Stage23Dependencies, because a second field would be
    // a second thing to wire and to forget. What it prevents: a project
    // pinned to an older rule set keeps the judgment prose it was verified
    // with, so a re-run reproduces its vintage instead of mixing two.
    prompt: renderPromptForJob(
      "attribution",
      input,
      deps.ruleSet.attribution_template_version,
    ),
    timeoutMs: deps.timeoutMs,
  };
  const outcome = await deps.orchestrator.run(backendId, job);
  if (outcome.status === "paused") {
    return { status: "paused", reason: outcome.reason };
  }
  if (outcome.status === "exhausted") {
    return {
      status: "exhausted",
      message:
        `Belegprüfungs-Urteil (${backendId}) für Beleg ${input.evidence.id} ` +
        `erschöpft: ${outcome.lastError.message}`,
    };
  }
  return { status: "ok", judgment: toJudgment(outcome.output) };
}

/**
 * Turns a stamped attribution output into the register's `Judgment`.
 *
 * The orchestrator stamps provenance; the PIPELINE owns the persisted
 * reasoning string. `resolvePersistedReasoning` is the codebase's single
 * branch on prose vintage — it hands a v1.0.0/v1.1.0 answer's own string back
 * byte-for-byte and joins a v1.2.0 answer's three fields. Re-deriving that
 * branch here would make it two, and two branches on the same question is how
 * the two drift.
 *
 * Module-local on purpose: the same category of internal as
 * `joinReasoningRoles` itself, and it belongs on no barrel.
 */
function toJudgment(output: StampedOutput<"attribution">): Judgment {
  return {
    backend: output.backend,
    model: output.model,
    relation_type: output.relation_type,
    confidence: output.confidence,
    reasoning: resolvePersistedReasoning(output),
    at: output.at,
  };
}

/** Types of the distinct sources whose resolved relation supports the claim
 * (supports or partially_supports) — one entry per source, not per evidence. */
function pertinentSourceTypes(
  claim: Claim,
  perEvidence: readonly EvidenceJudgingResult[],
  sourcesById: ReadonlyMap<string, Source>,
): SourceType[] {
  const relationByEvidence = new Map(
    perEvidence.map((entry) => [entry.evidenceId, entry.resolvedRelation]),
  );
  const pertinentSources = new Set(
    claim.evidence
      .filter((evidence) => {
        const relation = relationByEvidence.get(evidence.id);
        return relation === "supports" || relation === "partially_supports";
      })
      .map((evidence) => evidence.source_id),
  );
  return [...pertinentSources]
    .map((sourceId) => sourcesById.get(sourceId)?.custom.source_type)
    .filter((type): type is SourceType => type !== undefined);
}
