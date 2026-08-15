/**
 * Wiring for the corpus-driven end-to-end specs: a throwaway workspace, an
 * orchestrator around the replay backend, and the sequence of real use-cases
 * a project walks through.
 *
 * Two deliberate choices about how far the automation goes.
 *
 * The specs drive the pipeline steps EXPLICITLY rather than through the
 * global auto-chain. The chain resolves its own dependencies (real
 * `nodeHttpFetcher`, real `createProjectOrchestrator`), so letting it drain
 * here would put the live network and a real `claude` spawn in the path of a
 * test. Its sequencing policy — what chains onto what, coalescing, the
 * TOCTOU re-checks — is already covered edge for edge by
 * `lib/pipeline/runs/auto-chain.test.ts` with injected steps. What was
 * missing, and what these specs add, is whether the steps themselves survive
 * real data.
 *
 * The orchestrator is real. Only the backend behind it is replayed, so
 * output validation, the retry policy and trace writing all stay inside the
 * path under test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { Orchestrator } from "../../lib/adapters/orchestrator/orchestrator";
import type { Backend } from "../../lib/adapters/core/contracts";
import { createProject, importBriefing } from "../../lib/pipeline";
import type { ClaimsRegister } from "../../lib/register";
import { RegisterStore } from "../../lib/register";
import { createReplayBackend, type ReplayBackend } from "./replay-backend";

export interface CorpusWorkspace {
  readonly workspace: string;
  readonly projectDir: (projectId: string) => string;
  readonly store: (projectId: string) => RegisterStore;
  readonly cleanup: () => void;
}

/**
 * Temp workspace with the identity environment stubbed, matching the
 * convention every pipeline test already uses. `maxRetries` on the teardown
 * is not superstition: Windows CI releases the register's lock file
 * asynchronously, and the existing suite hits it.
 */
export function createCorpusWorkspace(): CorpusWorkspace {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-corpus-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  return {
    workspace,
    projectDir: (projectId) => path.join(workspace, projectId),
    store: (projectId) =>
      RegisterStore.atDirectory(path.join(workspace, projectId)),
    cleanup: () => {
      vi.unstubAllEnvs();
      fs.rmSync(workspace, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    },
  };
}

/**
 * Orchestrator over a replayed backend. The trace sink is a no-op here
 * because the specs assert on the register, not on `traces/`; the recorder
 * is what reads real traces, and `lib/pipeline/export/traces.test.ts` covers
 * the sink itself.
 */
export function corpusOrchestrator(backend: Backend): Orchestrator {
  return new Orchestrator({
    backends: [backend],
    traceSink: { write: async () => {} },
    gate: { run: (fn) => fn() },
    policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    sleep: async () => {},
  });
}

export interface CorpusProjectOptions {
  readonly id?: string;
  readonly researchQuestion?: string;
  readonly briefing: string;
  readonly tool?: string;
  readonly backend?: ReplayBackend;
}

export interface CorpusProject {
  readonly projectId: string;
  readonly backend: ReplayBackend;
  readonly orchestrator: Orchestrator;
  readonly read: () => Promise<ClaimsRegister>;
}

/**
 * A project with its briefing frozen — the state every failure class below
 * starts from. Both steps go through the public use-cases, so the genesis
 * chain entry and the briefing blob are produced the way production
 * produces them.
 */
export async function createCorpusProject(
  options: CorpusProjectOptions,
): Promise<CorpusProject> {
  const projectId = options.id ?? "proj_corpus";
  await createProject({
    id: projectId,
    research_question:
      options.researchQuestion ??
      "Welche Werkzeuge prüfen Claims LLM-recherchierter Briefings?",
    primaryCli: "claude",
  });
  await importBriefing({
    projectId,
    content: options.briefing,
    tool: options.tool ?? "deep-research-x",
  });
  const backend = options.backend ?? createReplayBackend();
  return {
    projectId,
    backend,
    orchestrator: corpusOrchestrator(backend),
    read: async () => RegisterStore.forProject(projectId).read(),
  };
}

/** Claim ids grouped by status — the assertion shape most specs want. */
export function statusesOf(register: ClaimsRegister): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const claim of register.claims) {
    (grouped[claim.status] ??= []).push(claim.id);
  }
  return grouped;
}

/** Project events of one kind, oldest first. */
export function eventsOfKind(
  register: ClaimsRegister,
  event: string,
): ClaimsRegister["project_events"] {
  return register.project_events.filter((entry) => entry.event === event);
}
