import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegisterStore } from "../../register";
import { createMockBackend } from "../backends/mock/mock-backend";
import type { AttributionInput, JobRequest } from "../core/jobs";
import { Orchestrator } from "../orchestrator/orchestrator";
import { renderPromptForJob } from "../prompts";
import { fileTraceSink } from "../runtime/trace-sink";
import { TraceEnvelope } from "./envelope";

/**
 * TMB-20 acceptance: every judgments[] entry in the register has a
 * corresponding trace entry. The correlation is structural — the judgment's
 * `at` is written from the same clock read as the successful envelope's
 * `finished_at`, and both carry the same backend/model.
 */
describe("judgment ↔ trace correlation", () => {
  let projectDir: string;
  let store: RegisterStore;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-correlation-"));
    store = RegisterStore.atDirectory(projectDir);
    await store.create({
      id: "proj_correlation-test",
      research_question: "Hat jedes Urteil einen Trace?",
      config: {
        rubric_version: "se-evidenz-rubrik-v1",
        adjudication_sample_rate: 0.1,
        backends: { primary: { cli: "claude", model_family: "anthropic" } },
      },
      actor: "human:lg",
    });
    await store.transaction((tx) => {
      tx.addSource({
        id: "src_meyer2025",
        type: "article-journal",
        title: "Effects of AI Assistants on Code Review Duration",
        custom: { source_type: "begutachtete_publikation" },
      } as never);
      tx.addClaim({
        claim: {
          id: "clm_0001",
          text: "LLM-Reviews reduzieren die Reviewzeit.",
          claim_type: "quantitativer_einzelbefund",
          briefing_anchor: "p1",
          provenance: {
            tool: "deep-research-x",
            model: "drx-1",
            extracted_at: "2026-08-06T08:10:00Z",
            search_path: "Lauf 1",
          },
          evidence: [
            {
              id: "ev_0001",
              source_id: "src_meyer2025",
              locator: { page: 6 },
              verbatim_excerpt: "…median review time dropped…",
              judgments: [],
            },
          ],
        },
        actor: "system:extraction",
        reason: "Aus dem Briefing extrahiert.",
      });
    });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("every merged judgment has a trace file with matching finished_at, backend and model", async () => {
    const orchestrator = new Orchestrator({
      backends: [createMockBackend()],
      traceSink: fileTraceSink,
      gate: { run: (fn) => fn() },
      policy: { maxAttempts: 1, retryBaseDelayMs: 1 },
    });

    const input: AttributionInput = {
      claim: {
        id: "clm_0001",
        text: "LLM-Reviews reduzieren die Reviewzeit.",
        claim_type: "quantitativer_einzelbefund",
        briefing_anchor: "p1",
      },
      evidence: {
        id: "ev_0001",
        source_id: "src_meyer2025",
        source_type: "begutachtete_publikation",
        locator: { page: 6 },
        verbatim_excerpt: "…median review time dropped…",
      },
    };
    const job: JobRequest<"attribution"> = {
      kind: "attribution",
      projectDir,
      input,
      prompt: renderPromptForJob("attribution", input),
      timeoutMs: 1_000,
    };

    // Two independent runs — as the divergence rule produces them.
    for (const run of [1, 2]) {
      void run;
      const outcome = await orchestrator.run("mock", job);
      if (outcome.status !== "ok")
        throw new Error(`unexpected ${outcome.status}`);
      await store.transaction((tx) => {
        tx.appendJudgment("clm_0001", "ev_0001", outcome.output);
      });
    }

    const register = await store.read();
    const judgments = register.claims[0].evidence[0].judgments;
    expect(judgments).toHaveLength(2);

    const envelopes = fs
      .readdirSync(path.join(projectDir, "traces"))
      .map((file) =>
        TraceEnvelope.parse(
          JSON.parse(
            fs.readFileSync(path.join(projectDir, "traces", file), "utf8"),
          ),
        ),
      );

    for (const judgment of judgments) {
      const correlated = envelopes.find(
        (envelope) =>
          envelope.finished_at === judgment.at &&
          envelope.backend === judgment.backend &&
          envelope.model === judgment.model &&
          envelope.error === undefined,
      );
      expect(
        correlated,
        `judgment at ${judgment.at} has a corresponding trace`,
      ).toBeDefined();
    }
  });
});
