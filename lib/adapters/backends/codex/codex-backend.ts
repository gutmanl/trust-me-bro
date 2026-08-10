import { UNKNOWN_MODEL } from "../../core/contracts";
import type {
  Backend,
  InvokeResult,
  ProcessRunner,
} from "../../core/contracts";
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

const BACKEND_ID = "codex";

export interface CodexBackendOptions {
  readonly processRunner?: ProcessRunner;
}

/**
 * Second model family (OpenAI) for the divergence rule: one non-interactive
 * `codex exec` child process per invoke, read-only sandbox, prompt via stdin
 * (`-` positional; argv length limits on Windows), project directory as cwd.
 * `--skip-git-repo-check` because a project directory is not a git repo.
 *
 * Codex emits JSONL events on stdout whose exact shape has drifted across
 * CLI versions; the parser accepts both the classic `{"msg":{...}}` and the
 * newer `{"type":"item.completed",...}` shape and takes the LAST agent
 * message as the payload — earlier messages are working notes.
 */
export function createCodexBackend(options: CodexBackendOptions = {}): Backend {
  const runner = options.processRunner ?? nodeProcessRunner;
  return {
    id: BACKEND_ID,
    async invoke<K extends JobKind>(
      job: JobRequest<K>,
    ): Promise<InvokeResult<K>> {
      const result = await runner.run({
        command: "codex",
        args: [
          "exec",
          "--json",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "-",
        ],
        cwd: job.projectDir,
        input: job.prompt.text,
        timeoutMs: job.timeoutMs,
      });

      if (result.timedOut) {
        throw new AdapterTimeoutError(BACKEND_ID, job.kind, job.timeoutMs);
      }

      const events = parseEvents(result.stdout);
      const errorDetails = events
        .map(errorMessageOf)
        .filter((message): message is string => message !== undefined);
      const rateLimitDetail = [result.stderr, ...errorDetails].find((detail) =>
        RATE_LIMIT_PATTERN.test(detail),
      );
      if (rateLimitDetail !== undefined) {
        throw new AdapterRateLimitError(
          BACKEND_ID,
          job.kind,
          rateLimitDetail.trim(),
        );
      }
      if (result.exitCode !== 0) {
        throw new AdapterProcessError(
          BACKEND_ID,
          job.kind,
          result.exitCode,
          (result.stderr || errorDetails.join("; ")).trim(),
        );
      }

      const payload = lastAgentMessage(events);
      if (payload === undefined) {
        throw new AdapterOutputError(
          BACKEND_ID,
          job.kind,
          "event stream contains no agent message",
          result.stdout,
        );
      }

      return {
        output: validateJobOutput(
          BACKEND_ID,
          job.kind,
          parsePayload(job.kind, payload),
        ),
        // S-11: an honest gap beats the backend id posing as a model.
        model: findModel(events) ?? UNKNOWN_MODEL,
      };
    },
  };
}

type CodexEvent = Record<string, unknown>;

/** Non-JSON lines (banners, progress noise) are skipped, not fatal. */
function parseEvents(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed) as CodexEvent);
    } catch {
      // tolerated: interleaved non-event output
    }
  }
  return events;
}

function msgOf(event: CodexEvent): Record<string, unknown> | undefined {
  return typeof event.msg === "object" && event.msg !== null
    ? (event.msg as Record<string, unknown>)
    : undefined;
}

function itemOf(event: CodexEvent): Record<string, unknown> | undefined {
  return typeof event.item === "object" && event.item !== null
    ? (event.item as Record<string, unknown>)
    : undefined;
}

function agentMessageOf(event: CodexEvent): string | undefined {
  const msg = msgOf(event);
  if (msg?.type === "agent_message" && typeof msg.message === "string") {
    return msg.message;
  }
  const item = itemOf(event);
  if (item?.type === "agent_message" && typeof item.text === "string") {
    return item.text;
  }
  return undefined;
}

function lastAgentMessage(events: CodexEvent[]): string | undefined {
  let last: string | undefined;
  for (const event of events) {
    last = agentMessageOf(event) ?? last;
  }
  return last;
}

function errorMessageOf(event: CodexEvent): string | undefined {
  const msg = msgOf(event);
  if (msg?.type === "error" && typeof msg.message === "string") {
    return msg.message;
  }
  if (event.type === "error" && typeof event.message === "string") {
    return event.message;
  }
  return undefined;
}

/** First `model` string found on an event or its msg — shape-tolerant. */
function findModel(events: CodexEvent[]): string | undefined {
  for (const event of events) {
    const candidates = [event.model, msgOf(event)?.model];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate !== "") {
        return candidate;
      }
    }
  }
  return undefined;
}

function parsePayload(kind: JobKind, message: string): unknown {
  try {
    return parseFencedJson(message);
  } catch (cause) {
    throw new AdapterOutputError(
      BACKEND_ID,
      kind,
      "agent message is not the requested JSON payload",
      message,
      { cause },
    );
  }
}
