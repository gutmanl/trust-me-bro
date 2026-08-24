import { createProjectOrchestrator, renderPromptForJob } from "../../adapters";
import type {
  EvidenceContext,
  JobRequest,
  Orchestrator,
  RepairInput,
  RepairOutput,
} from "../../adapters";
import { getCurrentActor, loadAdapterConfig } from "../../identity";
import type { Claim, ExcerptRevision, HistoryEntry } from "../../register";
import { isAtomicClaimText, routedRepairable } from "../../register";
import { RepairPreconditionError } from "../errors";
import { DEFAULT_MAX_REPAIR_CYCLES, requireProjectStore } from "../projects";
import { decideReEntry } from "./re-entry";
import type { ReEntryTarget } from "./re-entry";

/**
 * The repair step of the adjudication loop (TMB-37, widened by the
 * verdict-driven repair). Two separate impure boundaries, mirroring the
 * judge-then-persist split of the verification run:
 *
 * - `proposeRepair` asks the primary backend for an evidence-backed
 *   reformulation and returns it WITHOUT touching the register — the
 *   proposal is only ever a suggestion.
 * - `applyRepair` persists the reviewer's accepted/adjusted wording (and,
 *   since the verdict-driven repair, any accepted excerpt corrections) in
 *   ONE transaction: revise, transition to `revised`, then take the
 *   re-entry edge the mechanical rule selects.
 *
 * One loop, two critique drivers, not a fork (verdict-driven repair): a
 * `contested` claim's critique is the human complaint; a machine-parked
 * claim with a repairable routing gets its critique from the machine's own
 * record — the negative pre-check's reasoning, or the stage-1 quote
 * failure. The origin travels to the template so machine critiques are
 * framed as unconfirmed (P-14/P-15), and no code path ever forges a
 * `contested` decision (P-16): the direct edge
 * `pending_adjudication → revised` carries the human actor who accepted.
 */

const ACTOR_REPAIR = "system:repair" as const;

export type RepairProposalOutcome =
  | { status: "proposed"; suggestion: RepairOutput }
  | { status: "paused"; reason: string }
  | { status: "exhausted"; message: string };

export interface RepairDependencies {
  orchestrator?: Orchestrator;
}

/** Shared precondition of proposeRepair/applyRepair; takes the claim list
 * so it works on a read register AND inside a transaction (tx.listClaims).
 * `discardClaim` deliberately keeps the narrower `requireContested`
 * (REPAIR-06): a verdict-driven repair must never open a discard door. */
function requireRepairable(claims: Claim[], claimId: string): Claim {
  const claim = claims.find((candidate) => candidate.id === claimId);
  if (!claim) {
    throw new RepairPreconditionError(`Claim "${claimId}" existiert nicht.`);
  }
  if (claim.status === "contested") {
    return claim;
  }
  if (claim.status === "pending_adjudication" && routedRepairable(claim).ok) {
    return claim;
  }
  throw new RepairPreconditionError(
    `Claim "${claimId}" ist weder beanstandet noch mit reparierbarem ` +
      `Prüfbefund in der Warteschlange (Status: ${claim.status}).`,
  );
}

/** Precondition of the discard verb alone — see requireRepairable. */
function requireContested(claims: Claim[], claimId: string): Claim {
  const claim = claims.find((candidate) => candidate.id === claimId);
  if (!claim) {
    throw new RepairPreconditionError(`Claim "${claimId}" existiert nicht.`);
  }
  if (claim.status !== "contested") {
    throw new RepairPreconditionError(
      `Claim "${claimId}" ist nicht beanstandet (Status: ${claim.status}).`,
    );
  }
  return claim;
}

/**
 * The critique the repair job answers, derived from the claim's own state
 * (verdict-driven repair): a human complaint for `contested` claims, the
 * machine's verdict for machine-parked ones. Exported for the automatic
 * suggestion evaluator, which builds the identical job input.
 */
export function buildRepairCritique(claim: Claim): RepairInput["complaint"] {
  if (claim.status === "contested") {
    const complaintEntry = claim.history.findLast(
      (entry) => entry.to_status === "contested",
    );
    return {
      origin: "human",
      categories: complaintEntry?.decision?.categories ?? [],
      reason: complaintEntry?.reason ?? "Beanstandet ohne Begründung.",
    };
  }
  const routing = claim.history.at(-1)?.routing;
  if (routing === "negative_precheck") {
    return {
      origin: "negative_precheck",
      categories: [],
      reason:
        claim.calibration_reasoning ??
        claim.history.at(-1)?.reason ??
        "Negative Vorprüfung ohne aufgezeichnete Begründung.",
    };
  }
  if (routing === "existence_check_failed") {
    const failing = claim.evidence.filter(
      (evidence) => evidence.existence_check?.status === "failed",
    );
    const ids = failing.map((evidence) => evidence.id).join(", ");
    return {
      origin: "existence_check_failed",
      categories: [],
      reason:
        failing.length === 1
          ? `Die Zitatprüfung (Stufe 1) konnte das wörtliche Zitat des ` +
            `Belegs ${ids} nicht im eingefrorenen Dokument nachweisen.`
          : `Die Zitatprüfung (Stufe 1) konnte die wörtlichen Zitate der ` +
            `Belege ${ids} nicht im eingefrorenen Dokument nachweisen.`,
    };
  }
  // requireRepairable admitted the claim, so this is a programming error,
  // not a user-facing precondition.
  throw new Error(
    `buildRepairCritique: claim ${claim.id} has no repairable critique ` +
      `(status ${claim.status}, routing ${routing ?? "none"})`,
  );
}

/** The repair job for one claim, shared by the interactive proposal and the
 * automatic suggestion evaluator so the two can never drift. */
export function buildRepairJob(
  projectDir: string,
  claim: Claim,
  sourceTypeOf: (sourceId: string) => string | undefined,
): JobRequest<"repair"> {
  const input: RepairInput = {
    claim: {
      id: claim.id,
      text: claim.text,
      claim_type: claim.claim_type,
      briefing_anchor: claim.briefing_anchor,
    },
    evidence: claim.evidence.map((evidence): EvidenceContext => ({
      id: evidence.id,
      source_id: evidence.source_id,
      source_type: (sourceTypeOf(evidence.source_id) ??
        "grey_literature") as EvidenceContext["source_type"],
      locator: evidence.locator,
      verbatim_excerpt: evidence.verbatim_excerpt,
    })),
    complaint: buildRepairCritique(claim),
  };
  return {
    kind: "repair",
    projectDir,
    input,
    prompt: renderPromptForJob("repair", input),
    timeoutMs: loadAdapterConfig().timeoutMs,
  };
}

export async function proposeRepair(
  projectId: string,
  claimId: string,
  deps: RepairDependencies = {},
): Promise<RepairProposalOutcome> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const claim = requireRepairable(register.claims, claimId);
  const sourcesById = new Map(
    register.sources.map((source) => [source.id, source]),
  );
  const job = buildRepairJob(
    store.projectDir,
    claim,
    (sourceId) => sourcesById.get(sourceId)?.custom.source_type,
  );
  const orchestrator =
    deps.orchestrator ?? createProjectOrchestrator(register.config);
  const outcome = await orchestrator.run(
    register.config.backends.primary.cli,
    job,
  );
  if (outcome.status === "paused") {
    return { status: "paused", reason: outcome.reason };
  }
  if (outcome.status === "exhausted") {
    return {
      status: "exhausted",
      message: `Reparaturvorschlag erschöpft: ${outcome.lastError.message}`,
    };
  }
  return { status: "proposed", suggestion: outcome.output };
}

export interface ApplyRepairInput {
  newText: string;
  /** Provenance of the accepted wording, recorded in the reason. */
  source: "vorschlag_uebernommen" | "vorschlag_angepasst" | "manuell";
  /** The backend's proposal when the reviewer adjusted it — folded into the
   * reason so the proposal stays traceable (acceptance criterion TMB-37);
   * with "vorschlag_uebernommen" the new text IS the proposal. */
  proposedText?: string;
  /** Accepted excerpt corrections (verdict-driven repair): the wording the
   * frozen document actually contains, replacing a failed verbatim
   * excerpt. Each correction clears its evidence's existence check, so the
   * re-entry rule routes the claim through the full cascade and stage 1
   * re-establishes the quote against the corrected excerpt. */
  excerptRepairs?: { evidenceId: string; correctedExcerpt: string }[];
}

export interface ApplyRepairResult {
  revised: HistoryEntry;
  reentryTarget: ReEntryTarget;
}

export async function applyRepair(
  projectId: string,
  claimId: string,
  input: ApplyRepairInput,
): Promise<ApplyRepairResult> {
  const newText = input.newText.trim();
  if (newText.length === 0) {
    throw new RepairPreconditionError(
      "Die überarbeitete Fassung darf nicht leer sein.",
    );
  }
  // Atomicity is re-validated HERE, not left to the re-entry gates: the
  // existence_checked edge's gate never looks at the wording, and the captured
  // edge's gate rejection would surface as a crash instead of form feedback.
  // Rejecting keeps the repair loop interactive (the reviewer reformulates
  // immediately) rather than routing a knowingly invalid wording onward.
  if (!isAtomicClaimText(newText)) {
    throw new RepairPreconditionError(
      "Die überarbeitete Fassung bündelt mehrere Aussagen – bitte genau " +
        "genau eine Aussage formulieren.",
    );
  }
  const store = requireProjectStore(projectId);
  return store.transaction((tx) => {
    const claim = requireRepairable(tx.listClaims(), claimId);
    // Validate the excerpt corrections against the claim's live evidence
    // before any mutation; a no-op correction (same wording) is dropped
    // rather than minting an empty revision entry.
    const excerptRevisions: ExcerptRevision[] = [];
    for (const repair of input.excerptRepairs ?? []) {
      const evidence = claim.evidence.find(
        (candidate) => candidate.id === repair.evidenceId,
      );
      if (!evidence) {
        throw new RepairPreconditionError(
          `Beleg "${repair.evidenceId}" existiert nicht an Claim ` +
            `"${claimId}".`,
        );
      }
      const corrected = repair.correctedExcerpt.trim();
      if (corrected.length === 0) {
        throw new RepairPreconditionError(
          "Ein korrigiertes Zitat darf nicht leer sein.",
        );
      }
      if (corrected === evidence.verbatim_excerpt) {
        continue;
      }
      excerptRevisions.push({
        evidence_id: repair.evidenceId,
        previous_excerpt: evidence.verbatim_excerpt,
        new_excerpt: corrected,
      });
    }
    const sourceLabel = {
      vorschlag_uebernommen: "Vorschlag übernommen",
      vorschlag_angepasst: "Vorschlag angepasst",
      manuell: "manuell formuliert",
    }[input.source];
    const proposalTrace =
      input.source === "vorschlag_angepasst" && input.proposedText?.trim()
        ? ` Vorschlag war: „${input.proposedText.trim()}“`
        : "";
    const excerptTrace =
      excerptRevisions.length === 0
        ? ""
        : excerptRevisions.length === 1
          ? " Ein wörtliches Zitat wurde korrigiert."
          : ` ${excerptRevisions.length} wörtliche Zitate wurden korrigiert.`;
    tx.reviseClaimText(claimId, newText);
    for (const revision of excerptRevisions) {
      tx.reviseEvidenceExcerpt(
        claimId,
        revision.evidence_id,
        revision.new_excerpt,
      );
    }
    const revised = tx.transitionClaim(claimId, {
      to: "revised",
      actor: getCurrentActor(),
      reason: `Reparatur angenommen (${sourceLabel}).${proposalTrace}${excerptTrace}`,
      revision: { previous_text: claim.text, new_text: newText },
      ...(excerptRevisions.length > 0
        ? { excerpt_revisions: excerptRevisions }
        : {}),
    });
    const config = tx.getConfig();
    const decision = decideReEntry(
      tx.getClaim(claimId),
      config.max_repair_cycles ?? DEFAULT_MAX_REPAIR_CYCLES,
    );
    tx.transitionClaim(claimId, {
      to: decision.target,
      actor: ACTOR_REPAIR,
      reason: decision.reason,
      ...(decision.target === "pending_adjudication"
        ? { routing: "escalated" as const }
        : {}),
    });
    return { revised, reentryTarget: decision.target };
  });
}

/** Discard after a failed or declined repair (`contested → discarded`) —
 * the only path to discarded; the claim stays visible in the register. */
export async function discardClaim(
  projectId: string,
  claimId: string,
  reason: string,
): Promise<HistoryEntry> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new RepairPreconditionError(
      "Das Verwerfen erfordert eine Begründung.",
    );
  }
  const store = requireProjectStore(projectId);
  return store.transaction((tx) => {
    requireContested(tx.listClaims(), claimId);
    return tx.transitionClaim(claimId, {
      to: "discarded",
      actor: getCurrentActor(),
      reason: trimmed,
    });
  });
}
