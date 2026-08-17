import { createProjectOrchestrator, renderPromptForJob } from "../../adapters";
import type {
  EvidenceContext,
  JobRequest,
  Orchestrator,
  RepairInput,
  RepairOutput,
} from "../../adapters";
import { getCurrentActor, loadAdapterConfig } from "../../identity";
import type { Claim, HistoryEntry } from "../../register";
import { isAtomicClaimText } from "../../register";
import { RepairPreconditionError } from "../errors";
import { DEFAULT_MAX_REPAIR_CYCLES, requireProjectStore } from "../projects";
import { decideReEntry } from "./re-entry";
import type { ReEntryTarget } from "./re-entry";

/**
 * The repair step of the adjudication loop (TMB-37). Two separate impure
 * boundaries, mirroring the judge-then-persist split of the verification
 * run:
 *
 * - `proposeRepair` asks the primary backend for an evidence-backed
 *   reformulation (the long-scaffolded repair job's first call site) and
 *   returns it WITHOUT touching the register — the proposal is only ever a
 *   suggestion.
 * - `applyRepair` persists the reviewer's accepted/adjusted wording in ONE
 *   transaction: revise text, transition to `revised` (revision
 *   recorded, previous wording preserved), then take the re-entry edge the
 *   mechanical rule selects.
 */

const ACTOR_REPAIR = "system:repair" as const;

export type RepairProposalOutcome =
  | { status: "proposed"; suggestion: RepairOutput }
  | { status: "paused"; reason: string }
  | { status: "exhausted"; message: string };

export interface RepairDependencies {
  orchestrator?: Orchestrator;
}

/** Shared precondition of all three repair verbs; takes the claim list so
 * it works on a read register AND inside a transaction (tx.listClaims). */
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

export async function proposeRepair(
  projectId: string,
  claimId: string,
  deps: RepairDependencies = {},
): Promise<RepairProposalOutcome> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const claim = requireContested(register.claims, claimId);

  const complaintEntry = claim.history.findLast(
    (entry) => entry.to_status === "contested",
  );
  const sourcesById = new Map(
    register.sources.map((source) => [source.id, source]),
  );
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
      source_type:
        sourcesById.get(evidence.source_id)?.custom.source_type ??
        "grey_literature",
      locator: evidence.locator,
      verbatim_excerpt: evidence.verbatim_excerpt,
    })),
    complaint: {
      categories: complaintEntry?.decision?.categories ?? [],
      reason: complaintEntry?.reason ?? "Beanstandet ohne Begründung.",
    },
  };
  const job: JobRequest<"repair"> = {
    kind: "repair",
    projectDir: store.projectDir,
    input,
    prompt: renderPromptForJob("repair", input),
    timeoutMs: loadAdapterConfig().timeoutMs,
  };
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
    const claim = requireContested(tx.listClaims(), claimId);
    const sourceLabel = {
      vorschlag_uebernommen: "Vorschlag übernommen",
      vorschlag_angepasst: "Vorschlag angepasst",
      manuell: "manuell formuliert",
    }[input.source];
    const proposalTrace =
      input.source === "vorschlag_angepasst" && input.proposedText?.trim()
        ? ` Vorschlag war: „${input.proposedText.trim()}“`
        : "";
    tx.reviseClaimText(claimId, newText);
    const revised = tx.transitionClaim(claimId, {
      to: "revised",
      actor: getCurrentActor(),
      reason: `Reparatur angenommen (${sourceLabel}).${proposalTrace}`,
      revision: { previous_text: claim.text, new_text: newText },
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
