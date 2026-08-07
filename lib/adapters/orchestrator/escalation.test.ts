import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegisterStore } from "../../register";
import { createMockBackend } from "../backends/mock/mock-backend";
import type { TraceSink } from "../core/contracts";
import { AdapterTimeoutError } from "../core/errors";
import type { AttributionInput, JobRequest } from "../core/jobs";
import { renderPromptForJob } from "../prompts";
import { Orchestrator } from "./orchestrator";

/**
 * End-to-end proof of the TMB-19 escalation contract: an exhausted run is
 * the pipeline's signal to take the ratified existenzgeprueft →
 * zur_adjudikation edge — with the failure documented in the history entry,
 * never a silent drop. The register is imported here in TEST code only; the
 * production adapter layer stays register-free.
 */
describe("adapter failure escalation into the register", () => {
  let projectDir: string;
  let store: RegisterStore;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-escalation-"));
    store = RegisterStore.atDirectory(projectDir);
    await store.create({
      id: "proj_escalation-test",
      research_question: "Wird ein gescheiterter Adapter-Aufruf eskaliert?",
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
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "bestanden",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existenzgeprueft",
        actor: "system:existence_check",
        reason: "Wortlaut im Snapshot verifiziert.",
      });
    });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("escalates a claim to adjudication after exhausted retries, documenting the failure", async () => {
    const noopSink: TraceSink = { write: async () => undefined };
    const failing = createMockBackend({
      script: [
        new AdapterTimeoutError("mock", "attribution", 10),
        new AdapterTimeoutError("mock", "attribution", 10),
      ],
    });
    const orchestrator = new Orchestrator({
      backends: [failing],
      traceSink: noopSink,
      gate: { run: (fn) => fn() },
      policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
      sleep: async () => undefined,
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
      timeoutMs: 10,
    };

    const outcome = await orchestrator.run("mock", job);
    expect(outcome.status).toBe("exhausted");
    if (outcome.status !== "exhausted") throw new Error("unreachable");

    const entry = await store.transaction((tx) =>
      tx.transitionClaim("clm_0001", {
        to: "zur_adjudikation",
        actor: "system:adapter",
        reason: `LLM-Prüfaufruf endgültig gescheitert nach ${outcome.attempts} Versuchen: ${outcome.lastError.message}`,
      }),
    );

    expect(entry.to_status).toBe("zur_adjudikation");
    expect(entry.reason).toContain("2 Versuchen");
    const register = await store.read();
    expect(register.claims[0].status).toBe("zur_adjudikation");
    const verification = await store.verify();
    expect(verification.ok).toBe(true);
  });
});
