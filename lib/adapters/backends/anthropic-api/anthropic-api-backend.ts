import type {
  Backend,
  HttpPort,
  InvokeResult,
  TokenUsage,
} from "../../core/contracts";
import {
  AdapterOutputError,
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
} from "../../core/errors";
import type { JobKind, JobRequest } from "../../core/jobs";
import { validateJobOutput } from "../../core/validate";
import { nodeFetchHttpPort } from "../../runtime/node-fetch-http-port";
import { parseFencedJson } from "../fenced-json";

const BACKEND_ID = "anthropic-api";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Fixed for the spike; a productized adapter would make this configurable. */
const DEFAULT_MODEL = "claude-opus-5";
const MAX_TOKENS = 16_000;

/** The relevant subset of a Messages API response. */
interface MessagesEnvelope {
  readonly type?: unknown;
  readonly model?: unknown;
  readonly stop_reason?: unknown;
  readonly content?: unknown;
  readonly usage?: {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
  };
  readonly error?: { readonly type?: unknown; readonly message?: unknown };
}

export interface AnthropicApiBackendOptions {
  /** Required at construction — the registry only builds this backend when
   * the feature flag is on AND the key is present. */
  readonly apiKey: string;
  readonly httpPort?: HttpPort;
  readonly model?: string;
}

/**
 * TMB-51 spike: the Anthropic Messages API behind the SAME Backend port as
 * the CLI adapters — the existence proof of extension seam 1 (an API-based
 * backend is a further adapter, no change to pipeline or register). Scope is
 * deliberately minimal: only the attribution job kind is implemented (the
 * ticket's minimum), so this backend is only safe as a SECONDARY backend
 * (second-opinion path); other kinds fail as invalid_output and ride the
 * normal retry/escalation machinery. The generic job model would carry the
 * remaining kinds with no transport changes — noted, not built (spike).
 *
 * Never part of standard operation: reachable only when
 * TMB_ENABLE_API_BACKEND=1 and ANTHROPIC_API_KEY are both set (registry
 * gate); without them the prototype runs unchanged.
 */
export function createAnthropicApiBackend(
  options: AnthropicApiBackendOptions,
): Backend {
  const httpPort = options.httpPort ?? nodeFetchHttpPort;
  const model = options.model ?? DEFAULT_MODEL;
  return {
    id: BACKEND_ID,
    async invoke<K extends JobKind>(
      job: JobRequest<K>,
    ): Promise<InvokeResult<K>> {
      if (job.kind !== "attribution") {
        throw new AdapterOutputError(
          BACKEND_ID,
          job.kind,
          `job kind "${job.kind}" is not implemented by the API spike backend (attribution only)`,
          "",
        );
      }

      const result = await httpPort.request({
        url: MESSAGES_URL,
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          messages: [{ role: "user", content: job.prompt.text }],
        }),
        timeoutMs: job.timeoutMs,
      });

      if (result.timedOut) {
        throw new AdapterTimeoutError(BACKEND_ID, job.kind, job.timeoutMs);
      }
      if (result.status === null) {
        throw new AdapterProcessError(BACKEND_ID, job.kind, null, result.body);
      }

      let envelope: MessagesEnvelope;
      try {
        envelope = JSON.parse(result.body) as MessagesEnvelope;
      } catch (cause) {
        if (result.status === 429) {
          throw new AdapterRateLimitError(BACKEND_ID, job.kind, result.body);
        }
        throw new AdapterOutputError(
          BACKEND_ID,
          job.kind,
          `API response is not valid JSON (HTTP ${result.status})`,
          result.body,
          { cause },
        );
      }

      if (result.status !== 200) {
        const errorType =
          typeof envelope.error?.type === "string" ? envelope.error.type : "";
        const detail =
          typeof envelope.error?.message === "string"
            ? envelope.error.message
            : result.body;
        if (result.status === 429 || errorType === "rate_limit_error") {
          throw new AdapterRateLimitError(BACKEND_ID, job.kind, detail);
        }
        throw new AdapterProcessError(
          BACKEND_ID,
          job.kind,
          result.status,
          detail,
        );
      }

      // Safety classifiers decline with HTTP 200 + stop_reason "refusal" —
      // check before reading content.
      if (envelope.stop_reason === "refusal") {
        throw new AdapterProcessError(
          BACKEND_ID,
          job.kind,
          result.status,
          "API declined the request (stop_reason refusal)",
        );
      }

      const text = textOf(envelope);
      if (text === "") {
        throw new AdapterOutputError(
          BACKEND_ID,
          job.kind,
          "API response contains no text content",
          result.body,
        );
      }
      let candidate: unknown;
      try {
        candidate = parseFencedJson(text);
      } catch (cause) {
        throw new AdapterOutputError(
          BACKEND_ID,
          job.kind,
          "response text is not the requested JSON payload",
          text,
          { cause },
        );
      }

      const usage = usageOf(envelope);
      return {
        output: validateJobOutput(
          BACKEND_ID,
          job.kind,
          job.prompt.version,
          candidate,
        ),
        model: typeof envelope.model === "string" ? envelope.model : model,
        ...(usage !== undefined ? { usage } : {}),
      };
    },
  };
}

/** The Messages API `usage` block (finding 6), when present and numeric. */
function usageOf(envelope: MessagesEnvelope): TokenUsage | undefined {
  const input = envelope.usage?.input_tokens;
  const output = envelope.usage?.output_tokens;
  const usage: TokenUsage = {
    ...(typeof input === "number" ? { inputTokens: input } : {}),
    ...(typeof output === "number" ? { outputTokens: output } : {}),
  };
  return usage.inputTokens === undefined && usage.outputTokens === undefined
    ? undefined
    : usage;
}

/** Concatenates the text blocks (thinking blocks stream with empty text). */
function textOf(envelope: MessagesEnvelope): string {
  if (!Array.isArray(envelope.content)) {
    return "";
  }
  return envelope.content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}
