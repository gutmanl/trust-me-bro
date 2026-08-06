/**
 * Manual smoke check for the real agent-CLI backends (TMB-17/TMB-18): runs
 * all four job kinds against a throwaway example project and reports whether
 * the outputs are schema-valid. Deliberately NOT part of the vitest suite —
 * it spends real subscription quota and needs an authenticated CLI.
 *
 *   npx tsx scripts/adapter-smoke.ts claude
 *   npx tsx scripts/adapter-smoke.ts codex
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Backend, JobKind, JobRequest } from "../lib/adapters";
import { createClaudeBackend, renderPromptForJob } from "../lib/adapters";

const TIMEOUT_MS = 300_000;

function buildBackend(id: string): Backend {
  if (id === "claude") {
    return createClaudeBackend();
  }
  throw new Error(`unknown backend "${id}" (expected: claude)`);
}

function makeExampleProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-smoke-"));
  const excerpt =
    "In our controlled study with 24 professional developers, the median " +
    "review time dropped from 42 to 19 minutes (-55%) when an LLM assistant " +
    "pre-annotated the changeset.";
  fs.mkdirSync(path.join(projectDir, "blobs", "aa"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "blobs", "aa", "example-source.txt"),
    excerpt,
    "utf8",
  );
  return projectDir;
}

const claim = {
  id: "clm_0001",
  text: "LLM-gestuetzte Code-Reviews reduzieren die mediane Reviewzeit um etwa 55 %.",
  claim_type: "quantitativer_einzelbefund",
  briefing_anchor: "p1",
} as const;

const evidence = {
  id: "ev_0001",
  source_id: "src_meyer2025",
  locator: { page: 1 },
  verbatim_excerpt:
    "the median review time dropped from 42 to 19 minutes (-55%)",
} as const;

function jobs(projectDir: string): { [K in JobKind]: JobRequest<K> } {
  const inputs = {
    extraction: {
      research_question:
        "Reduzieren LLM-gestuetzte Code-Review-Werkzeuge die Reviewzeit messbar?",
      briefing_text:
        "p1: Eine kontrollierte Studie (Meyer 2025) zeigt: LLM-gestuetzte " +
        "Code-Reviews reduzieren die mediane Reviewzeit um etwa 55 % " +
        '("median review time dropped from 42 to 19 minutes (-55%)", S. 1).',
      sources: [{ id: "src_meyer2025", citation: "Meyer (2025), IEEE TSE" }],
    },
    attribution: { claim, evidence },
    rubric: {
      claim,
      evidence: [evidence],
      rubric_version: "se-evidenz-rubrik-v1",
    },
    repair: {
      claim,
      evidence: [evidence],
      complaint: {
        category: "leitsatz_nicht_herleitbar",
        reason:
          "Die Verallgemeinerung über Studienkontexte hinaus trägt der Einzelbefund nicht.",
      },
    },
  } as const;
  const make = <K extends JobKind>(kind: K): JobRequest<K> => ({
    kind,
    projectDir,
    input: inputs[kind] as JobRequest<K>["input"],
    prompt: renderPromptForJob(kind, inputs[kind] as never),
    timeoutMs: TIMEOUT_MS,
  });
  return {
    extraction: make("extraction"),
    attribution: make("attribution"),
    rubric: make("rubric"),
    repair: make("repair"),
  };
}

async function main(): Promise<number> {
  const backendId = process.argv[2];
  if (!backendId) {
    console.error("usage: npx tsx scripts/adapter-smoke.ts <claude|codex>");
    return 2;
  }
  const backend = buildBackend(backendId);
  const projectDir = makeExampleProject();
  console.log(`backend: ${backend.id}`);
  console.log(`example project: ${projectDir}`);

  let failures = 0;
  for (const job of Object.values(jobs(projectDir))) {
    const startedAt = Date.now();
    process.stdout.write(`- ${job.kind} … `);
    try {
      // A resolved invoke() is schema-valid by the Backend contract.
      const result = await backend.invoke(job);
      console.log(
        `ok (${Math.round((Date.now() - startedAt) / 1000)}s, model ${result.model})`,
      );
      console.log(`  ${JSON.stringify(result.output).slice(0, 200)}`);
    } catch (error) {
      failures += 1;
      console.log(`FAILED: ${error instanceof Error ? error.message : error}`);
    }
  }
  fs.rmSync(projectDir, { recursive: true, force: true });
  console.log(
    failures === 0 ? "all job kinds ok" : `${failures} job kind(s) failed`,
  );
  return failures === 0 ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
});
