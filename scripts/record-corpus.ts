/**
 * Records the real-world corpus the end-to-end specs replay.
 *
 *   npm run corpus:record -- --http
 *   npm run corpus:record -- --http --llm
 *   npm run corpus:record -- --http --llm --documents
 *
 * Deliberately NOT part of the vitest suite, for the same reasons
 * `scripts/adapter-smoke.ts` is not: it needs the open internet, and `--llm`
 * spends real subscription quota against an authenticated `claude` CLI.
 *
 * The method is the point. Rather than issuing a hand-written list of URLs —
 * which drifts from what the code actually requests, and produces cassettes
 * that are never hit — this script runs the SAME scenario the specs run,
 * through the same use-cases, with the real `nodeHttpFetcher` wrapped in a
 * recorder. Every request the pipeline makes is captured under exactly the
 * key the replay will look up, because both are derived from the same call.
 *
 * What it writes, all under `tests/corpus/`:
 *   http/<key>.json        one recorded HTTP interaction
 *   llm/<kind>/<key>.json  one recorded LLM answer, harvested from traces/
 *   documents/<name>       large binaries (gitignored)
 *   documents.json         their hash manifest
 *
 * Redaction happens on the way in: a contact address or credential in a
 * query string is replaced before anything touches disk.
 *
 * Prerequisites
 *   --http       outbound access to doi.org, export.arxiv.org,
 *                api.crossref.org and (optionally) api.unpaywall.org.
 *                Set TMB_UNPAYWALL_EMAIL to record the Unpaywall step;
 *                without it that step is skipped, exactly as in production.
 *   --llm        `claude` on the PATH and logged in (`claude -p "ping"`).
 *   --documents  outbound access to the publishers' PDF hosts.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Orchestrator } from "../lib/adapters/orchestrator/orchestrator";
import { createClaudeBackend } from "../lib/adapters/backends/claude/claude-backend";
import { fileTraceSink } from "../lib/adapters/runtime/trace-sink";
import {
  captureSource,
  createProject,
  importBriefing,
  startExistenceCheck,
  startReferenceScan,
  startSourceExtraction,
} from "../lib/pipeline";
import type {
  FetchedResource,
  FetchOptions,
  HttpFetcher,
} from "../lib/pipeline/sources/fetch-port";
import { nodeHttpFetcher } from "../lib/pipeline/sources/node-http-fetcher";
import type { CorpusDocument, HttpCassette } from "../tests/corpus/cassette";
import {
  httpCassetteKey,
  llmCassetteKey,
  redactUrl,
} from "../tests/corpus/cassette";
import { createReplayBackend } from "../tests/corpus/replay-backend";
import { extractionSeed, REFERENCE_PARSE_SEED } from "../tests/corpus/llm-seed";
import {
  SCENARIO_BRIEFING,
  SOURCE_AUDIT_TRAILS,
  SOURCE_UNRESOLVABLE,
} from "../tests/corpus/scenarios";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const corpusRoot = path.join(repoRoot, "tests", "corpus");
const RECORDER = "record-corpus/1";

/** Bodies larger than this are written to `documents/` instead of inline, so
 * the repository does not grow a megabyte of base64 per PDF. */
const INLINE_BODY_LIMIT = 64 * 1024;

const TEXTUAL_CONTENT_TYPES = [
  "application/json",
  "application/atom+xml",
  "application/xml",
  "text/xml",
  "text/html",
  "text/plain",
  "application/vnd.citationstyles.csl+json",
];

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function documentNameFor(url: string): string {
  const parsed = new URL(url);
  const base = path.basename(parsed.pathname) || parsed.hostname;
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-");
  return /\.[A-Za-z0-9]+$/.test(safe) ? safe : `${safe}.pdf`;
}

/**
 * Wraps the production fetcher and writes a cassette per call.
 *
 * Recording the REAL implementation matters: redirect chains, the SSRF
 * guard and the response-size cap all run, so a URL that production could
 * not fetch never lands in the corpus as if it could.
 */
function recordingFetcher(documents: Map<string, CorpusDocument>): HttpFetcher {
  return {
    async fetch(url: string, options?: FetchOptions) {
      const resource: FetchedResource = await nodeHttpFetcher.fetch(
        url,
        options,
      );
      const key = httpCassetteKey(url, options?.accept);
      const isTextual =
        resource.contentType !== null &&
        TEXTUAL_CONTENT_TYPES.includes(resource.contentType);

      let bodyFields: Pick<HttpCassette, "bodyText" | "bodyDocument">;
      if (isTextual && resource.body.length <= INLINE_BODY_LIMIT) {
        bodyFields = { bodyText: resource.body.toString("utf8") };
      } else {
        const name = documentNameFor(url);
        const relative = path.join("documents", name);
        const absolute = path.join(corpusRoot, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, resource.body);
        documents.set(name, {
          name,
          url: redactUrl(url),
          sha256: createHash("sha256").update(resource.body).digest("hex"),
          sha256_source: "recorded",
          bytes: resource.body.length,
          file: relative,
          note: "Recorded from the live source; not committed (see .gitignore).",
        });
        bodyFields = { bodyDocument: name };
        console.log(`  doc   ${name}  (${resource.body.length} bytes)`);
      }

      const cassette: HttpCassette = {
        key,
        url: redactUrl(url),
        ...(options?.accept ? { accept: options.accept } : {}),
        status: resource.status,
        contentType: resource.contentType,
        ...bodyFields,
        ...(resource.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: resource.retryAfterMs }),
        provenance: {
          kind: "recorded",
          recorded_at: new Date().toISOString(),
          recorder: RECORDER,
        },
      };
      writeJson(path.join(corpusRoot, "http", `${key}.json`), cassette);
      console.log(`  http  ${resource.status}  ${redactUrl(url)}`);
      return resource;
    },
  };
}

/**
 * Turns the trace envelopes a run left behind into LLM cassettes.
 *
 * No instrumentation is needed because the orchestrator already writes one
 * immutable `{method, params, result, prompt_sha256}` file per attempt into
 * `traces/`. Failed attempts carry an `error` instead of a `result` and are
 * skipped — a recording of a timeout replays as a wrong answer, not as a
 * timeout.
 */
function harvestTraces(projectDir: string): number {
  const tracesDir = path.join(projectDir, "traces");
  if (!fs.existsSync(tracesDir)) {
    return 0;
  }
  let written = 0;
  for (const name of fs.readdirSync(tracesDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const envelope = JSON.parse(
      fs.readFileSync(path.join(tracesDir, name), "utf8"),
    );
    if (envelope.result === undefined) {
      continue;
    }
    const key = llmCassetteKey(envelope.method, envelope.params);
    writeJson(path.join(corpusRoot, "llm", envelope.method, `${key}.json`), {
      key,
      method: envelope.method,
      params: envelope.params,
      result: envelope.result,
      backend: envelope.backend,
      model: envelope.model,
      prompt_version: envelope.prompt_version,
      prompt_sha256: envelope.prompt_sha256,
      provenance: {
        kind: "recorded",
        recorded_at: envelope.finished_at,
        recorder: RECORDER,
      },
    });
    console.log(`  llm   ${envelope.method}  ${key}`);
    written += 1;
  }
  return written;
}

function loadDocuments(): Map<string, CorpusDocument> {
  const file = path.join(corpusRoot, "documents.json");
  if (!fs.existsSync(file)) {
    return new Map();
  }
  const manifest: { documents: CorpusDocument[] } = JSON.parse(
    fs.readFileSync(file, "utf8"),
  );
  return new Map(manifest.documents.map((entry) => [entry.name, entry]));
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const useLlm = flags.has("--llm");
  if (!flags.has("--http") && !useLlm) {
    console.error(
      "Nothing to do. Pass --http and/or --llm " +
        "(see the doc comment for prerequisites).",
    );
    process.exitCode = 1;
    return;
  }

  const documents = loadDocuments();
  // Seed entries keep their committed stand-in; a recording replaces the
  // hash and marks it observed.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-record-"));
  process.env.TMB_WORKSPACE = workspace;
  process.env.TMB_ACTOR_HANDLE ??= "recorder";

  const projectId = "proj_corpus_recording";
  const fetcher = recordingFetcher(documents);

  console.log(`Recording into ${corpusRoot}`);
  console.log(`Scratch workspace: ${workspace}`);
  console.log(useLlm ? "LLM: real claude backend" : "LLM: seeded replay\n");

  const orchestratorFor = (seed: Parameters<typeof createReplayBackend>[0]) =>
    new Orchestrator({
      backends: [useLlm ? createClaudeBackend() : createReplayBackend(seed)],
      // Real sink: this is what `harvestTraces` reads afterwards.
      traceSink: fileTraceSink,
      gate: { run: (fn) => fn() },
      policy: { maxAttempts: 2, retryBaseDelayMs: 500 },
    });

  await createProject({
    id: projectId,
    research_question:
      "Welche Werkzeuge prüfen Claims LLM-recherchierter Briefings?",
    primaryCli: "claude",
  });
  await importBriefing({
    projectId,
    content: SCENARIO_BRIEFING,
    tool: "deep-research-x",
  });

  console.log("\n1/4  reference scan");
  const scan = await startReferenceScan(projectId, {
    orchestrator: orchestratorFor({ seed: REFERENCE_PARSE_SEED }),
    fetcher,
  });
  console.log("     ", await scan.done);

  console.log("\n2/4  capture (the resolvable source)");
  const source = await captureSource(
    {
      projectId,
      kind: "arxiv",
      identifier: SOURCE_AUDIT_TRAILS.identifier,
      sourceType: "peer_reviewed_publication",
    },
    { fetcher },
  );
  console.log("     ", source.id);

  console.log("\n3/4  capture (the identifier that resolves to nothing)");
  try {
    await captureSource(
      {
        projectId,
        kind: "arxiv",
        identifier: SOURCE_UNRESOLVABLE.identifier,
        sourceType: "peer_reviewed_publication",
      },
      { fetcher },
    );
    console.log(
      "      NOTE: this identifier resolved. The exclusion log recorded it " +
        "as unresolvable in July 2026; arXiv may have since issued it, or " +
        "the corpus scenario needs a new one.",
    );
  } catch (error) {
    console.log("      expected failure:", (error as Error).message);
  }

  console.log("\n4/4  extraction + existence check");
  const extraction = await startSourceExtraction(projectId, source.id, {
    orchestrator: orchestratorFor({ seed: extractionSeed(source.id) }),
  });
  console.log("     ", await extraction.done);
  const existence = await startExistenceCheck(projectId, { fetcher });
  console.log("     ", await existence.done);

  const projectDir = path.join(workspace, projectId);
  const llmCount = useLlm ? harvestTraces(projectDir) : 0;

  writeJson(path.join(corpusRoot, "documents.json"), {
    documents: [...documents.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  });

  console.log(
    `\nDone. ${fs.readdirSync(path.join(corpusRoot, "http")).length} HTTP ` +
      `cassettes on disk, ${llmCount} LLM cassette(s) harvested, ` +
      `${documents.size} document(s).`,
  );
  console.log(
    "Review the diff before committing — recorded bodies are third-party " +
      "content, and `documents/` is gitignored on purpose.",
  );
  console.log(`\nScratch workspace left for inspection: ${workspace}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
