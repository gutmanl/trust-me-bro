/**
 * Builds the workspace the browser suite runs against.
 *
 * Playwright drives the real Next.js server, and that server resolves its own
 * dependencies — the live `nodeHttpFetcher` and a real `claude` spawn. Rather
 * than adding a test-only seam to production code so the browser could drive
 * capture and extraction (an env var that swaps the fetcher would put test
 * wiring into the shipped app, which the architecture guards exist to
 * prevent), the workspace is populated OUT OF BAND here, through the same
 * pipeline use-cases and the same corpus the vitest specs use.
 *
 * The division that follows is deliberate and worth stating, because it
 * bounds what these tests can claim: the browser suite covers everything a
 * human does to an existing project — reading the briefing, adjudicating,
 * repairing, exporting, navigating — and does not cover the network-driven
 * steps that produced it. Those are covered end to end in
 * `tests/e2e/corpus-pipeline.e2e.test.ts`, where the ports are injectable.
 */
import fs from "node:fs";

import { Orchestrator } from "../../lib/adapters/orchestrator/orchestrator";
import {
  captureSource,
  createProject,
  importBriefing,
  startExistenceCheck,
  startSourceExtraction,
} from "../../lib/pipeline";
import { cassetteFetcher } from "../corpus/cassette-fetcher";
import { extractionSeed, misquotingExtractionSeed } from "../corpus/llm-seed";
import { createReplayBackend } from "../corpus/replay-backend";
import { SCENARIO_BRIEFING, SOURCE_AUDIT_TRAILS } from "../corpus/scenarios";
import { BROWSER_WORKSPACE } from "./workspace-path";

export const BROWSER_PROJECT_ID = "proj_browser-corpus";
export const BROWSER_RESEARCH_QUESTION =
  "Welche Werkzeuge prüfen Claims LLM-recherchierter Briefings?";

function orchestratorFor(seed: ReturnType<typeof extractionSeed>) {
  return new Orchestrator({
    backends: [createReplayBackend({ seed })],
    traceSink: { write: async () => {} },
    gate: { run: (fn) => fn() },
    policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    sleep: async () => {},
  });
}

/**
 * Clears and rebuilds the browser workspace: one project mid-review, with a
 * frozen briefing, a captured source carrying its real frozen PDF, one claim
 * whose quote stage 1 proved and one whose quote it could not — so the
 * adjudication queue the browser exercises is non-empty for an honest reason
 * rather than because a fixture said so.
 */
export async function seedBrowserWorkspace(): Promise<string> {
  const workspace = BROWSER_WORKSPACE;
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(workspace, { recursive: true });
  process.env.TMB_WORKSPACE = workspace;
  process.env.TMB_ACTOR_HANDLE = "lg";

  await createProject({
    id: BROWSER_PROJECT_ID,
    research_question: BROWSER_RESEARCH_QUESTION,
    primaryCli: "claude",
  });
  await importBriefing({
    projectId: BROWSER_PROJECT_ID,
    content: SCENARIO_BRIEFING,
    tool: "deep-research-x",
  });

  const fetcher = cassetteFetcher();
  const source = await captureSource(
    {
      projectId: BROWSER_PROJECT_ID,
      kind: "arxiv",
      identifier: SOURCE_AUDIT_TRAILS.identifier,
      sourceType: "peer_reviewed_publication",
    },
    { fetcher },
  );

  for (const seed of [
    extractionSeed(source.id),
    misquotingExtractionSeed(source.id),
  ]) {
    const handle = await startSourceExtraction(BROWSER_PROJECT_ID, source.id, {
      orchestrator: orchestratorFor(seed),
    });
    await handle.done;
  }

  const existence = await startExistenceCheck(BROWSER_PROJECT_ID, { fetcher });
  await existence.done;

  if (fetcher.misses().length > 0) {
    throw new Error(
      `browser workspace seeding hit missing cassettes: ${fetcher
        .misses()
        .join(", ")}`,
    );
  }

  return workspace;
}
