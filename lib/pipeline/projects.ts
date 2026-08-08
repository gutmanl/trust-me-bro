import fs from "node:fs";

import { getCurrentActor, getWorkspaceRoot } from "../identity";
import {
  countClaimsByStatus,
  lastActivityAt,
  ProjectId,
  RegisterStore,
} from "../register";
import type {
  ChainVerificationResult,
  ClaimsRegister,
  ClaimStatus,
  ProjectConfig,
} from "../register";
import {
  InvalidProjectInputError,
  ProjectAlreadyExistsError,
  UnknownProjectError,
} from "./errors";
import { pendingRelevancePopulation } from "./warm/select-claims";

/** The two agent CLIs the registry knows; the model family follows the CLI. */
export type BackendCli = "claude" | "codex";

const MODEL_FAMILY: Record<BackendCli, string> = {
  claude: "anthropic",
  codex: "openai",
};

export const DEFAULT_RUBRIC_VERSION = "se-evidenz-rubrik-v1";
export const DEFAULT_ADJUDICATION_SAMPLE_RATE = 0.1;
/** Repair cycles before the loop escalates to the reviewer (TMB-37); applied
 * at point of use for registers whose config predates the field. */
export const DEFAULT_MAX_REPAIR_CYCLES = 2;
/** Second-opinion criteria (Divergenzregel): request the secondary backend's
 * judgment when the primary confidence is below the threshold or the primary
 * relation is not `stuetzt`. */
export const DEFAULT_SECOND_OPINION = {
  confidence_threshold: 0.8,
  on_relation_not_stuetzt: true,
} as const;

export interface CreateProjectInput {
  id: string;
  research_question: string;
  primaryCli: BackendCli;
  /** Absent = single model family; the pipeline runs with the divergence
   * rule disabled and the config's missing `secondary` records that. */
  secondaryCli?: BackendCli;
}

export interface ProjectSummary {
  /** Routing identity: the workspace directory name (URL segment). */
  id: string;
  /** Chain-bound inner project id, set only when it differs from `id` —
   * i.e. for projects imported under a different workspace name (TMB-40).
   * The genesis hash covers the inner id, so it is never rewritten. */
  origin_id?: string;
  research_question: string;
  created_at: string;
  briefing_imported: boolean;
  source_count: number;
  claim_counts: Record<ClaimStatus, number>;
  total_claims: number;
  last_change_at: string;
  /** Claims adopted from another project (warm run, TMB-43). */
  adopted_claims: number;
  /** Adopted claims still awaiting a completed relevance sweep. */
  pending_relevance: number;
}

/** The backends block from the two-CLI registry; shared by project creation
 * and the settings use-case (TMB-46) so the CLI→family mapping has one
 * home. Not part of the public barrel. */
export function buildBackendsConfig(
  primaryCli: BackendCli,
  secondaryCli?: BackendCli,
): ProjectConfig["backends"] {
  return {
    primary: {
      cli: primaryCli,
      model_family: MODEL_FAMILY[primaryCli],
    },
    ...(secondaryCli
      ? {
          secondary: {
            cli: secondaryCli,
            model_family: MODEL_FAMILY[secondaryCli],
          },
        }
      : {}),
  };
}

function buildProjectConfig(input: CreateProjectInput): ProjectConfig {
  return {
    rubric_version: DEFAULT_RUBRIC_VERSION,
    adjudication_sample_rate: DEFAULT_ADJUDICATION_SAMPLE_RATE,
    max_repair_cycles: DEFAULT_MAX_REPAIR_CYCLES,
    backends: buildBackendsConfig(input.primaryCli, input.secondaryCli),
    // Auto-enabled exactly when a second model family exists; single-backend
    // projects stay valid and simply never trigger second opinions.
    ...(input.secondaryCli ? { second_opinion: DEFAULT_SECOND_OPINION } : {}),
  };
}

/**
 * Creates a project directory per the file format appendix: claims.json with
 * the genesis project_created event, schema/claims.schema.json, empty blob
 * store by construction. id, research_question and created_at are immutable
 * afterwards — no update capability exists anywhere in the pipeline.
 */
export async function createProject(
  input: CreateProjectInput,
): Promise<ClaimsRegister> {
  const research_question = input.research_question.trim();
  if (research_question.length === 0) {
    throw new InvalidProjectInputError(
      "Die Recherchefrage darf nicht leer sein.",
    );
  }
  if (!ProjectId.safeParse(input.id).success) {
    throw new InvalidProjectInputError(
      `Projekt-Id "${input.id}" ist ungültig: erwartet wird z. B. "proj_beispiel-2026" ` +
        "(Kleinbuchstaben, Ziffern, '.', '_', '-').",
    );
  }
  if (input.secondaryCli && input.secondaryCli === input.primaryCli) {
    throw new InvalidProjectInputError(
      "Die zweite Modellfamilie muss sich von der ersten unterscheiden (Divergenzregel).",
    );
  }
  const store = RegisterStore.forProject(input.id);
  if (store.exists()) {
    throw new ProjectAlreadyExistsError(input.id);
  }
  try {
    return await store.create({
      id: input.id,
      research_question,
      config: buildProjectConfig(input),
      actor: getCurrentActor(),
    });
  } catch (error) {
    // The store re-checks under the project lock; map its rejection so the
    // TOCTOU window between exists() and create() surfaces as the same error.
    if (error instanceof Error && /already initialized/.test(error.message)) {
      throw new ProjectAlreadyExistsError(input.id);
    }
    throw error;
  }
}

function toSummary(
  directoryName: string,
  register: ClaimsRegister,
): ProjectSummary {
  return {
    id: directoryName,
    ...(register.project.id !== directoryName
      ? { origin_id: register.project.id }
      : {}),
    research_question: register.project.research_question,
    created_at: register.project.created_at,
    briefing_imported: register.project.briefing_import !== undefined,
    source_count: register.sources.length,
    claim_counts: countClaimsByStatus(register.claims),
    total_claims: register.claims.length,
    last_change_at: lastActivityAt(register),
    adopted_claims: register.claims.filter(
      (claim) => claim.provenance.origin_project_id !== undefined,
    ).length,
    pending_relevance: pendingRelevancePopulation(
      register.claims,
      register.project_events,
    ).length,
  };
}

/**
 * Summaries of every project below the workspace root, newest change first.
 * Directories that are no valid project (foreign dirs, corrupt registers)
 * are skipped with a warning instead of breaking the whole list.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const root = getWorkspaceRoot();
  if (!fs.existsSync(root)) {
    return [];
  }
  const summaries: ProjectSummary[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    let store: RegisterStore;
    try {
      store = RegisterStore.forProject(entry.name);
    } catch {
      continue; // directory name outside the project-id pattern
    }
    if (!store.exists()) {
      continue;
    }
    try {
      summaries.push(toSummary(entry.name, await store.read()));
    } catch (error) {
      console.warn(`Projekt "${entry.name}" ist nicht lesbar:`, error);
    }
  }
  return summaries.sort((a, b) =>
    a.last_change_at < b.last_change_at ? 1 : -1,
  );
}

/** Store of an existing project; UnknownProjectError otherwise. Shared by
 * the pipeline's use-case modules, not part of the public barrel. */
export function requireProjectStore(projectId: string): RegisterStore {
  let store: RegisterStore;
  try {
    store = RegisterStore.forProject(projectId);
  } catch {
    throw new UnknownProjectError(projectId);
  }
  if (!store.exists()) {
    throw new UnknownProjectError(projectId);
  }
  return store;
}

export async function getProjectSummary(
  projectId: string,
): Promise<ProjectSummary> {
  return toSummary(projectId, await requireProjectStore(projectId).read());
}

/** Full register of a project, for detail views. */
export async function readProject(projectId: string): Promise<ClaimsRegister> {
  return requireProjectStore(projectId).read();
}

/** Hash-chain verification of the persisted register (TMB-38: the history
 * view's integrity indicator, same check as `tmb verify`). */
export async function getChainVerification(
  projectId: string,
): Promise<ChainVerificationResult> {
  return requireProjectStore(projectId).verify();
}
