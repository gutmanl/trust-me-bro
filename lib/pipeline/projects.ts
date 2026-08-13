import fs from "node:fs";
import path from "node:path";

import {
  getCurrentActor,
  getWorkspaceRoot,
  loadAnthropicApiKey,
  loadFeatureFlags,
} from "../identity";
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
  ProjectArchiveBlockedError,
  UnknownProjectError,
} from "./errors";
import { getGlobalJobRunner } from "./runs/job-runner";
import { pendingRelevancePopulation } from "./warm/select-claims";

/** Workspace subdirectory that holds archived projects. A leading dot keeps
 * it out of listProjects: resolveProjectDir rejects any id starting with ".",
 * so the directory can never be read back as a project. */
const ARCHIVE_DIRNAME = ".trash";

/** The backends the registry knows; the model family follows the id. The
 * "anthropic-api" entry is the TMB-51 spike — selectable only while its
 * feature flag is on. "mock" is the demonstration backend: always
 * selectable, because it exists precisely for users without a paid CLI. */
export type BackendCli = "claude" | "codex" | "anthropic-api" | "mock";

const MODEL_FAMILY: Record<BackendCli, string> = {
  claude: "anthropic",
  codex: "openai",
  "anthropic-api": "anthropic",
  // Its own family, so the divergence rule treats it as distinct from every
  // real backend and a mock/claude pair stays a valid second opinion.
  mock: "mock",
};

/** The demonstration backend's id. A project whose PRIMARY backend is this
 * one is a demo project: its findings are canned, not verified. */
export const DEMO_BACKEND_CLI = "mock";

/** The divergence rule compares model FAMILIES, not backend ids: claude and
 * anthropic-api are distinct backends of the same family and therefore no
 * valid second-opinion pair. Shared by creation and settings validation. */
export function modelFamilyOf(cli: BackendCli): string {
  return MODEL_FAMILY[cli];
}

/**
 * Family of a backend id that is NOT known to be one of ours — an id read
 * out of a free-string field, e.g. `briefing_import.tool` in a bundle
 * imported from another installation. Returns undefined for anything this
 * installation does not know, so the caller has to decide what an unknown
 * backend means instead of being handed a confident wrong answer.
 *
 * Separate from modelFamilyOf on purpose: the validated call sites (project
 * creation, settings) check against allowedBackendClis first and genuinely
 * cannot get undefined, and widening their return type would make a
 * hazard look present where there is none.
 */
export function knownModelFamilyOf(cli: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(MODEL_FAMILY, cli)
    ? MODEL_FAMILY[cli as BackendCli]
    : undefined;
}

/** TMB-51: the API spike backend is selectable only while its feature flag
 * AND the API key are both present — without them the option disappears
 * from the UI and server-side validation alike. */
export function isApiBackendEnabled(): boolean {
  return (
    loadFeatureFlags().apiBackendEnabled && loadAnthropicApiKey() !== undefined
  );
}

export function allowedBackendClis(): readonly BackendCli[] {
  return isApiBackendEnabled()
    ? ["claude", "codex", "anthropic-api", "mock"]
    : ["claude", "codex", "mock"];
}

/**
 * True for a project whose primary backend is the demonstration backend —
 * every judgement in it is canned, so the UI badges it as such. Derived from
 * the config rather than stored: there is no demo flag in the file format,
 * and the durable provenance is the `system:demo_seed` actor in the chained
 * history, which survives export and `tmb verify`.
 */
export function isDemoProject(config: ProjectConfig): boolean {
  return config.backends.primary.cli === DEMO_BACKEND_CLI;
}

export const DEFAULT_RUBRIC_VERSION = "se-evidence-rubric-v1.1";
export const DEFAULT_ADJUDICATION_SAMPLE_RATE = 0.1;
/** Repair cycles before the loop escalates to the reviewer (TMB-37); applied
 * at point of use for registers whose config predates the field. */
export const DEFAULT_MAX_REPAIR_CYCLES = 2;
/** Second-opinion criteria (divergence rule): request the secondary backend's
 * judgment when the primary confidence is below the threshold or the primary
 * relation is not `supports`. */
export const DEFAULT_SECOND_OPINION = {
  confidence_threshold: 0.8,
  on_relation_not_supports: true,
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
  /** Primary backend is the demonstration backend (TMB-54) — derived, not
   * stored. The list badges it so a demo project is never mistaken for
   * verification work. */
  is_demo: boolean;
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
  const backendClis = allowedBackendClis();
  for (const cli of [input.primaryCli, input.secondaryCli]) {
    if (cli !== undefined && !backendClis.includes(cli)) {
      throw new InvalidProjectInputError(`Unbekanntes Backend "${cli}".`);
    }
  }
  if (input.primaryCli === "anthropic-api") {
    // The spike implements only the attribution job kind (TMB-51) — as
    // primary it could never run extraction; secondary-only by design.
    throw new InvalidProjectInputError(
      'Das Spike-Backend "anthropic-api" ist nur als sekundäres Backend nutzbar.',
    );
  }
  if (
    input.secondaryCli &&
    modelFamilyOf(input.secondaryCli) === modelFamilyOf(input.primaryCli)
  ) {
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
    is_demo: isDemoProject(register.config),
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

/**
 * Archives a project: moves its whole directory into the workspace's
 * `.trash/` instead of deleting it, so the append-only register and its blob
 * store survive intact and the project simply disappears from listProjects
 * (the archive dir is unreadable as a project by construction). Recoverable
 * by moving the directory back by hand — this prototype has no restore UI.
 *
 * Refuses while a run is active for the project (any kind): the runner holds
 * the single-writer invariant, and renaming the directory out from under an
 * in-flight capture/verification would send its next write to a path that no
 * longer exists. The caller waits for the run or cancels it, then retries.
 *
 * The move is a same-filesystem rename (the archive lives under the same
 * workspace root), so it is atomic — the project is either listed or
 * archived, never half of each. A name already taken in `.trash/` (the same
 * id archived, recreated, archived again) gets a numeric suffix.
 */
export async function archiveProject(projectId: string): Promise<void> {
  const store = requireProjectStore(projectId);
  if (getGlobalJobRunner().isRunning(projectId)) {
    throw new ProjectArchiveBlockedError(projectId);
  }
  const archiveRoot = path.join(getWorkspaceRoot(), ARCHIVE_DIRNAME);
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.renameSync(store.projectDir, uniqueArchiveTarget(archiveRoot, projectId));
}

/** A collision-free path inside the archive dir: the project id, then
 * `-2`, `-3`, … if an earlier archive of the same id is already there. */
function uniqueArchiveTarget(archiveRoot: string, projectId: string): string {
  let target = path.join(archiveRoot, projectId);
  let ordinal = 2;
  while (fs.existsSync(target)) {
    target = path.join(archiveRoot, `${projectId}-${ordinal}`);
    ordinal += 1;
  }
  return target;
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
