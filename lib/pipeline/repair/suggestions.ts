import {
  createProjectOrchestrator,
  CURRENT_PROMPT_VERSION,
} from "../../adapters";
import type { Orchestrator } from "../../adapters";
import { getCurrentActor } from "../../identity";
import type {
  Claim,
  ClaimRepairSuggestion,
  ClaimsRegister,
} from "../../register";
import { routedRepairable } from "../../register";
import { PipelineError } from "../errors";
import { requireProjectStore } from "../projects";
import { deriveMechanicalCaps } from "../verification/mechanical-cap";
import {
  anchoredBriefingParagraph,
  buildRepairCritique,
  buildRepairJob,
} from "./run-repair";

/**
 * Verdict-driven repair suggestions: durable, machine-generated repair
 * proposals for claims a machine parked in adjudication, pre-computed by
 * the auto-chain so they are already on the card when the reviewer opens
 * the queue.
 *
 * Recorded divergence from the roadmap's REPAIR-03 ("on demand only, never
 * pre-computed"): pre-computation is an operator decision (2026-08-24).
 * The other halves of the original mitigation stand — the suggestion is
 * labelled machine-generated and unconfirmed in the UI, accepting it is
 * still a deliberate human step through the ordinary apply flow, and
 * nothing is ever pre-filled into a field that commits.
 */

/** One open claim-repair suggestion, app-facing. */
export interface ClaimRepairSuggestionVM {
  claimId: string;
  origin: "negative_precheck" | "existence_check_failed";
  suggestedText: string;
  reasoning: string;
  evidenceRepairs?: { evidenceId: string; correctedExcerpt: string }[];
  /** Rewritten briefing paragraph carrying the repaired assertion. */
  briefingRepair?: string;
  /**
   * The suggestion was generated with an older repair prompt than the
   * current one — e.g. a pre-1.2.0 suggestion that carries no briefing
   * passage. Outdated suggestions stay visible (they may still be useful)
   * but no longer block regeneration: the eligibility check treats the
   * claim as needing a fresh suggestion, and a newly recorded one
   * supersedes the old event in chain order.
   */
  outdated: boolean;
  promptVersion: string;
  backend: string;
  recordedAt: string;
}

/**
 * A suggestion is open only while the claim is exactly as it was when the
 * suggestion was generated: still machine-parked with a repairable routing,
 * and with the SAME history length — any later transition (a re-run, a
 * confirmation, an applied repair) supersedes the suggestion structurally,
 * without a dismissal event and without prose parsing.
 */
const stillOpenFor = (
  claim: Claim | undefined,
  suggestion: ClaimRepairSuggestion,
): boolean =>
  claim !== undefined &&
  claim.status === "pending_adjudication" &&
  claim.history.length === suggestion.history_length &&
  routedRepairable(claim).ok;

/**
 * The still-open claim-repair suggestions of a register: latest
 * `claim_repair_suggestion` per claim in chain order, superseded by a later
 * dismissal (`claim_repair_suggestion_dismissed` naming the claim) or by
 * any claim transition since generation (see `stillOpenFor`). Pure register
 * derivation, mirroring `deriveOpenRepairActions` for sources.
 */
export function deriveOpenClaimRepairSuggestions(
  register: Pick<ClaimsRegister, "claims" | "project_events">,
): ClaimRepairSuggestionVM[] {
  const open = new Map<
    string,
    { payload: ClaimRepairSuggestion; at: string }
  >();
  for (const event of register.project_events) {
    if (
      event.event === "claim_repair_suggestion_dismissed" &&
      event.claim_id !== undefined
    ) {
      open.delete(event.claim_id);
      continue;
    }
    const payload = event.claim_repair_suggestion;
    if (event.event !== "claim_repair_suggestion" || payload === undefined) {
      continue;
    }
    open.set(payload.claim_id, { payload, at: event.at });
  }
  const claimsById = new Map(register.claims.map((claim) => [claim.id, claim]));
  return [...open.values()]
    .filter(({ payload }) =>
      stillOpenFor(claimsById.get(payload.claim_id), payload),
    )
    .map(({ payload, at }) => ({
      claimId: payload.claim_id,
      origin: payload.origin,
      suggestedText: payload.suggested_text,
      reasoning: payload.reasoning,
      ...(payload.evidence_repairs !== undefined
        ? {
            evidenceRepairs: payload.evidence_repairs.map((repair) => ({
              evidenceId: repair.evidence_id,
              correctedExcerpt: repair.corrected_excerpt,
            })),
          }
        : {}),
      ...(payload.briefing_repair !== undefined
        ? { briefingRepair: payload.briefing_repair }
        : {}),
      outdated: payload.prompt_version !== CURRENT_PROMPT_VERSION.repair,
      promptVersion: payload.prompt_version,
      backend: payload.backend,
      recordedAt: at,
    }));
}

/**
 * Claims worth an automatic repair suggestion: machine-parked with a
 * repairable routing (the same gate the direct repair edge re-checks) and
 * no open suggestion yet. Shared by the auto-chain fan-out and the
 * per-project backfill so the two cannot drift.
 */
export function claimsEligibleForRepairSuggestion(
  register: Pick<ClaimsRegister, "claims" | "project_events">,
): string[] {
  // An OUTDATED open suggestion (older prompt version, see the VM field)
  // does not block regeneration: the claim counts as needing a suggestion
  // again, and the newly recorded event supersedes the old one in chain
  // order — otherwise a register full of pre-1.2.0 suggestions would never
  // pick up the briefing passage.
  const open = new Set(
    deriveOpenClaimRepairSuggestions(register)
      .filter((entry) => !entry.outdated)
      .map((entry) => entry.claimId),
  );
  return register.claims
    .filter(
      (claim) =>
        claim.status === "pending_adjudication" &&
        routedRepairable(claim).ok &&
        !open.has(claim.id),
    )
    .map((claim) => claim.id);
}

/** Project-id variant for the auto-chain, which owns no register access of
 * its own. */
export async function claimsNeedingRepairSuggestionForProject(
  projectId: string,
): Promise<string[]> {
  const register = await requireProjectStore(projectId).read();
  // The AUTOMATIC list additionally skips mechanically capped
  // negative-precheck claims: no wording can lift a verdict the rule set
  // caps, so an unasked-for suggestion would only spend quota and a repair
  // cycle to land exactly where it started. The per-claim button bypasses
  // this deliberately — an explicit request is the reviewer's own call, and
  // the card warns beside it. Failed-quote claims stay in: their excerpt
  // repair is meaningful regardless of the cap.
  const caps = deriveMechanicalCaps(register);
  return claimsEligibleForRepairSuggestion(register).filter((claimId) => {
    const claim = register.claims.find((candidate) => candidate.id === claimId);
    return !(
      claim?.history.at(-1)?.routing === "negative_precheck" &&
      caps[claimId] !== undefined
    );
  });
}

export interface ClaimRepairEvaluationDeps {
  orchestrator?: Orchestrator;
}

/**
 * The `claim_repair_evaluation` trigger's work: generate ONE repair
 * suggestion for one eligible claim and record it durably. Ineligibility at
 * run time (the claim was decided, re-run or already has a suggestion) is a
 * routine no-op, not an error — triggers are enqueued from a snapshot the
 * world may have moved past. A paused (rate-limited) or exhausted backend
 * records nothing: the per-claim button and the next chain pass simply try
 * again, and the trigger bracket keeps the attempt visible.
 */
export async function evaluateClaimRepair(
  projectId: string,
  claimId: string,
  deps: ClaimRepairEvaluationDeps = {},
): Promise<void> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  if (!claimsEligibleForRepairSuggestion(register).includes(claimId)) {
    return;
  }
  const claim = register.claims.find((candidate) => candidate.id === claimId);
  if (claim === undefined) {
    return;
  }
  const critique = buildRepairCritique(claim);
  if (critique.origin === "human") {
    // Structurally unreachable behind the eligibility check; guards the
    // origin narrowing below.
    return;
  }
  const historyLength = claim.history.length;
  const sourcesById = new Map(
    register.sources.map((source) => [source.id, source]),
  );
  const job = buildRepairJob(
    store.projectDir,
    claim,
    (sourceId) => sourcesById.get(sourceId)?.custom.source_type,
    anchoredBriefingParagraph(projectId, register, claimId),
  );
  const orchestrator =
    deps.orchestrator ?? createProjectOrchestrator(register.config);
  const outcome = await orchestrator.run(
    register.config.backends.primary.cli,
    job,
  );
  if (outcome.status !== "ok") {
    console.warn(
      `claim repair suggestion for "${claimId}" not recorded: ` +
        `backend ${outcome.status}`,
    );
    return;
  }
  const suggestion: ClaimRepairSuggestion = {
    claim_id: claimId,
    origin: critique.origin,
    suggested_text: outcome.output.suggested_text,
    reasoning: outcome.output.reasoning,
    ...(outcome.output.evidence_repairs !== undefined &&
    outcome.output.evidence_repairs.length > 0
      ? {
          evidence_repairs: outcome.output.evidence_repairs.map((repair) => ({
            evidence_id: repair.evidence_id,
            corrected_excerpt: repair.corrected_excerpt,
          })),
        }
      : {}),
    ...(outcome.output.briefing_repair !== undefined
      ? { briefing_repair: outcome.output.briefing_repair }
      : {}),
    prompt_version: job.prompt.version,
    backend: register.config.backends.primary.cli,
    history_length: historyLength,
  };
  await store.transaction((tx) => {
    // TOCTOU re-check under the lock: the LLM call above took real time,
    // and a reviewer's decision or a re-run in that window makes this
    // suggestion stale before it is even recorded.
    const live = tx.listClaims().find((candidate) => candidate.id === claimId);
    if (!stillOpenFor(live, suggestion)) {
      return;
    }
    const openNow = deriveOpenClaimRepairSuggestions({
      claims: tx.listClaims(),
      project_events: tx.listProjectEvents(),
    });
    // A CURRENT open suggestion blocks the write; an outdated one is
    // exactly what this regeneration supersedes.
    if (openNow.some((entry) => entry.claimId === claimId && !entry.outdated)) {
      return;
    }
    tx.recordClaimRepairSuggestion({
      suggestion,
      actor: "system:repair",
      reason:
        critique.origin === "negative_precheck"
          ? "Reparaturvorschlag aus der negativen Vorprüfung erzeugt."
          : "Reparaturvorschlag aus der fehlgeschlagenen Zitatprüfung erzeugt.",
    });
  });
}

/**
 * Dismisses an open claim-repair suggestion: the human judgment "this
 * proposal is not it", recorded under the human's own actor — the
 * suggestion disappears, the chain keeps it.
 */
export async function dismissClaimRepairSuggestion(
  projectId: string,
  claimId: string,
): Promise<void> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  if (
    !deriveOpenClaimRepairSuggestions(register).some(
      (entry) => entry.claimId === claimId,
    )
  ) {
    throw new PipelineError(
      "Zu dieser Aussage liegt kein offener Reparaturvorschlag vor.",
    );
  }
  await store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "claim_repair_suggestion_dismissed",
      reason: "Reparaturvorschlag verworfen.",
      actor: getCurrentActor(),
      claim_id: claimId,
    });
  });
}
