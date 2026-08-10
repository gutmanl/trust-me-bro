import { createProjectOrchestrator, renderPromptForJob } from "../../adapters";
import type { JobRequest, Orchestrator, ResearchInput } from "../../adapters";
import { loadAdapterConfig } from "../../identity";
import type { ClaimsRegister, RegisterStore } from "../../register";
import { importBriefing } from "../briefing";
import { ResearchPreconditionError } from "../errors";
import { permissiveBackendPreflight, probeBackendUsable } from "../health";
import type { BackendPreflight } from "../health";
import { requireProjectStore } from "../projects";
import { getGlobalJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import type { RunHandle } from "../runs/types";
import { deriveResearchState } from "./derive-state";
import type { ResearchState } from "./derive-state";

const ACTOR = "system:research" as const;

/**
 * Provenance prefix of a briefing this application researched itself. The
 * exact format matters and is binding: the independence notice parses the
 * backend id back out of it (see researchBackendOf). A manually imported
 * briefing keeps whatever tool name the user gave, and is therefore never
 * mistaken for a self-generated one.
 */
export const RESEARCH_TOOL_PREFIX = "trustmebro-research/";

/** The backend id of a self-researched briefing, or undefined when the
 * briefing was imported from elsewhere. */
export function researchBackendOf(
  tool: string | undefined,
): string | undefined {
  if (tool === undefined || !tool.startsWith(RESEARCH_TOOL_PREFIX)) {
    return undefined;
  }
  const id = tool.slice(RESEARCH_TOOL_PREFIX.length).trim();
  return id.length > 0 ? id : undefined;
}

export interface ResearchDependencies {
  orchestrator?: Orchestrator;
  runner?: JobRunner;
  preflight?: BackendPreflight;
}

export interface ResearchRunSummary {
  outcome: "completed" | "failed";
  message: string;
}

/**
 * Starts the initial research: the primary backend writes a briefing from
 * the project's research question, which then goes through the ORDINARY
 * freeze path (importBriefing). There is deliberately no second route by
 * which briefing truth enters the register — a self-researched briefing is
 * frozen, hashed and verified exactly like an imported one, and differs
 * only in the recorded provenance.
 */
export async function startResearch(
  projectId: string,
  deps: ResearchDependencies = {},
): Promise<RunHandle<ResearchRunSummary>> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  if (register.project.briefing_import) {
    throw new ResearchPreconditionError(
      "Für dieses Projekt ist bereits ein Briefing eingefroren – " +
        "die Recherche erzeugt die Originalfassung und läuft daher nur einmal.",
    );
  }

  const preflight =
    deps.preflight ??
    (deps.orchestrator ? permissiveBackendPreflight : probeBackendUsable);
  const primaryReady = await preflight(register.config.backends.primary.cli);
  if (!primaryReady.usable) {
    throw new ResearchPreconditionError(
      `Primäres Backend nicht einsatzbereit: ${primaryReady.hint ?? "unbekannt"}`,
    );
  }

  const runner = deps.runner ?? getGlobalJobRunner();
  const orchestrator =
    deps.orchestrator ?? createProjectOrchestrator(register.config);

  return runner.submit(
    projectId,
    ["research"],
    () => "research",
    (_item, { runId }) =>
      runResearchOnce({
        projectId,
        store,
        register,
        orchestrator,
        backendId: register.config.backends.primary.cli,
        timeoutMs: loadAdapterConfig().timeoutMs,
        runId,
      }),
    { kind: "research" },
  );
}

/** Register-derived research state plus live-run knowledge, for UI/SSE. */
export function getResearchState(
  projectId: string,
  register: ClaimsRegister,
  deps: { runner?: JobRunner } = {},
): ResearchState {
  const runner = deps.runner ?? getGlobalJobRunner();
  return deriveResearchState(register, runner.isRunning(projectId, "research"));
}

/** The live (or latest) run handle of a project, for the SSE stream. */
export function getResearchRun(
  projectId: string,
  deps: { runner?: JobRunner } = {},
): RunHandle | undefined {
  return (deps.runner ?? getGlobalJobRunner()).currentRun(
    projectId,
    "research",
  );
}

interface RunContext {
  projectId: string;
  store: RegisterStore;
  register: ClaimsRegister;
  orchestrator: Orchestrator;
  backendId: string;
  timeoutMs: number;
  runId: string;
}

async function runResearchOnce(
  context: RunContext,
): Promise<ResearchRunSummary> {
  const { projectId, store, register, orchestrator, backendId, runId } =
    context;

  await store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "research_run_started",
      reason: `Erstrecherche gestartet (Backend ${backendId}, Lauf ${runId}).`,
      actor: ACTOR,
    });
  });

  const input: ResearchInput = {
    research_question: register.project.research_question,
  };
  const job: JobRequest<"research"> = {
    kind: "research",
    projectDir: store.projectDir,
    input,
    prompt: renderPromptForJob("research", input),
    timeoutMs: context.timeoutMs,
  };

  const outcome = await orchestrator.run(backendId, job);

  if (outcome.status !== "ok") {
    const message =
      outcome.status === "paused"
        ? `Lauf pausiert (Rate-Limit): ${outcome.reason} – später erneut starten.`
        : `Recherche nach ${outcome.attempts} Versuch(en) erschöpft: ${outcome.lastError.message}`;
    await recordCompletion(store, message);
    return { outcome: "failed", message };
  }

  try {
    // The ordinary freeze path, so the generated briefing is hashed,
    // chain-bracketed and projected exactly like an imported one.
    await importBriefing({
      projectId,
      content: outcome.output.briefing_markdown,
      tool: `${RESEARCH_TOOL_PREFIX}${backendId}`,
    });
  } catch (error) {
    const message = `Erzeugtes Briefing konnte nicht eingefroren werden: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await recordCompletion(store, message);
    return { outcome: "failed", message };
  }

  const message = `Briefing erzeugt und eingefroren (Backend ${backendId}, Modell ${outcome.model}).`;
  await recordCompletion(store, message);
  return { outcome: "completed", message };
}

function recordCompletion(store: RegisterStore, reason: string): Promise<void> {
  return store.transaction((tx) => {
    tx.recordProjectEvent({
      event: "research_run_completed",
      reason,
      actor: ACTOR,
    });
  });
}
