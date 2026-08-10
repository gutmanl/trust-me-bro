import { UNKNOWN_MODEL } from "../../core/contracts";
import type { Backend, ProcessRunner } from "../../core/contracts";
import type { InvokeResult } from "../../core/contracts";
import {
  AdapterOutputError,
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
} from "../../core/errors";
import type { JobKind, JobRequest } from "../../core/jobs";
import { validateJobOutput } from "../../core/validate";
import { nodeProcessRunner } from "../../runtime/node-process-runner";
import { parseFencedJson } from "../fenced-json";
import { RATE_LIMIT_PATTERN } from "../rate-limit-signal";

const BACKEND_ID = "claude";

/**
 * Read-only tool set for the child session: file reading and searching in
 * the project directory, no writes, no shell, no web.
 */
const READ_ONLY_TOOLS = "Read,Glob,Grep";

/** The relevant subset of the `claude -p --output-format json` envelope. */
interface ClaudeEnvelope {
  readonly is_error?: boolean;
  readonly result?: unknown;
  readonly model?: unknown;
  readonly modelUsage?: unknown;
  readonly structured_output?: unknown;
}

/**
 * The envelope's model field has moved across CLI versions; current versions
 * (observed with 2.1.223) report per-model usage under `modelUsage` instead.
 * When neither field carries a model, the result is UNKNOWN_MODEL rather
 * than the backend id (S-11): recording "claude" as the model would make the
 * provenance record indistinguishable from a run that really used a model of
 * that name.
 */
function modelOf(envelope: ClaudeEnvelope): string {
  if (typeof envelope.model === "string" && envelope.model !== "") {
    return envelope.model;
  }
  if (typeof envelope.modelUsage === "object" && envelope.modelUsage !== null) {
    const [first] = Object.keys(envelope.modelUsage);
    if (first !== undefined && first !== "") {
      return first;
    }
  }
  return UNKNOWN_MODEL;
}

export interface ClaudeBackendOptions {
  readonly processRunner?: ProcessRunner;
}

/**
 * Primary backend: one `claude -p --output-format json` child process per
 * invoke, working directory = project directory (the CLI reads the frozen
 * blobs locally, nothing is uploaded), prompt via stdin (argv length limits
 * on Windows). `--setting-sources project` + `--strict-mcp-config` keep the
 * run hermetic — no user-level settings, memory or MCP servers leak in —
 * without `--bare`, which would drop subscription (OAuth) authentication.
 */
export function createClaudeBackend(
  options: ClaudeBackendOptions = {},
): Backend {
  const runner = options.processRunner ?? nodeProcessRunner;
  return {
    id: BACKEND_ID,
    async invoke<K extends JobKind>(
      job: JobRequest<K>,
    ): Promise<InvokeResult<K>> {
      const result = await runner.run({
        command: "claude",
        args: [
          "-p",
          "--output-format",
          "json",
          "--permission-mode",
          "dontAsk",
          "--allowedTools",
          READ_ONLY_TOOLS,
          "--setting-sources",
          "project",
          "--strict-mcp-config",
        ],
        cwd: job.projectDir,
        input: job.prompt.text,
        timeoutMs: job.timeoutMs,
      });

      if (result.timedOut) {
        throw new AdapterTimeoutError(BACKEND_ID, job.kind, job.timeoutMs);
      }
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        if (RATE_LIMIT_PATTERN.test(detail)) {
          throw new AdapterRateLimitError(BACKEND_ID, job.kind, detail);
        }
        throw new AdapterProcessError(
          BACKEND_ID,
          job.kind,
          result.exitCode,
          detail,
        );
      }

      let envelope: ClaudeEnvelope;
      try {
        envelope = JSON.parse(result.stdout) as ClaudeEnvelope;
      } catch (cause) {
        throw new AdapterOutputError(
          BACKEND_ID,
          job.kind,
          "CLI envelope is not valid JSON",
          result.stdout,
          { cause },
        );
      }

      const model = modelOf(envelope);

      if (envelope.is_error === true) {
        const detail =
          typeof envelope.result === "string"
            ? envelope.result
            : JSON.stringify(envelope.result);
        if (RATE_LIMIT_PATTERN.test(detail)) {
          throw new AdapterRateLimitError(BACKEND_ID, job.kind, detail);
        }
        throw new AdapterProcessError(
          BACKEND_ID,
          job.kind,
          result.exitCode,
          detail,
        );
      }

      const candidate =
        envelope.structured_output !== undefined
          ? envelope.structured_output
          : parseResultPayload(job.kind, envelope.result);

      return {
        output: validateJobOutput(BACKEND_ID, job.kind, candidate),
        model,
      };
    },
  };
}

function parseResultPayload(kind: JobKind, result: unknown): unknown {
  if (typeof result !== "string") {
    throw new AdapterOutputError(
      BACKEND_ID,
      kind,
      "envelope has no result text",
      JSON.stringify(result),
    );
  }
  try {
    return parseFencedJson(result);
  } catch (cause) {
    throw new AdapterOutputError(
      BACKEND_ID,
      kind,
      "result text is not the requested JSON payload",
      result,
      { cause },
    );
  }
}
