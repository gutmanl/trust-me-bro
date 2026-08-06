import { randomUUID } from "node:crypto";

import type {
  Backend,
  Clock,
  ConcurrencyGate,
  TraceSink,
} from "../core/contracts";
import { AdapterError, UnknownBackendError } from "../core/errors";
import type { JobIO, JobKind, JobRequest } from "../core/jobs";
import { decideNextAttempt, type RetryPolicy } from "../core/retry";
import { validateJobOutput } from "../core/validate";
import { systemClock } from "../runtime/system-clock";
import type { TraceEnvelope } from "../trace/envelope";
import type { RunOutcome, StampedOutput } from "./types";

export interface OrchestratorOptions {
  readonly backends: readonly Backend[];
  readonly traceSink: TraceSink;
  readonly gate: ConcurrencyGate;
  readonly policy: RetryPolicy;
  readonly clock?: Clock;
  /** Injectable for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly generateTraceId?: () => string;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The impure shell around every backend call (TMB-19/20): per attempt it
 * acquires a concurrency slot, invokes the backend, re-validates the output
 * (belt and braces on top of the backend contract — invalid data cannot
 * reach the register through this path), stamps provenance, and writes one
 * trace envelope — for failed and retried attempts too. All decisions
 * (retry, pause, exhaust) are delegated to the pure retry policy.
 *
 * The orchestrator performs no register writes: an `exhausted` outcome is
 * the pipeline's signal to escalate the claim, keeping the adapter layer
 * free of RegisterStore (clean dependency direction, extension seam 1).
 */
export class Orchestrator {
  private readonly backends: ReadonlyMap<string, Backend>;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly generateTraceId: () => string;

  constructor(private readonly options: OrchestratorOptions) {
    this.backends = new Map(
      options.backends.map((backend) => [backend.id, backend]),
    );
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? realSleep;
    this.generateTraceId = options.generateTraceId ?? randomUUID;
  }

  async run<K extends JobKind>(
    backendId: string,
    job: JobRequest<K>,
  ): Promise<RunOutcome<K>> {
    const backend = this.backends.get(backendId);
    if (backend === undefined) {
      throw new UnknownBackendError(backendId);
    }

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const startedAt = this.clock.now();
      try {
        const invoked = await this.options.gate.run(() => backend.invoke(job));
        const output = validateJobOutput(backend.id, job.kind, invoked.output);
        const finishedAt = this.clock.now();
        const stamped = stampOutput(
          job.kind,
          output,
          backend.id,
          invoked.model,
          finishedAt,
        );
        await this.writeTrace(job, backend.id, attempt, startedAt, finishedAt, {
          model: invoked.model,
          result: stamped,
        });
        return {
          status: "ok",
          output: stamped,
          model: invoked.model,
          attempts: attempt,
        };
      } catch (error) {
        if (!(error instanceof AdapterError)) {
          throw error; // programming error, not an attempt outcome
        }
        const finishedAt = this.clock.now();
        await this.writeTrace(job, backend.id, attempt, startedAt, finishedAt, {
          model: null,
          error,
        });
        const decision = decideNextAttempt(error, attempt, this.options.policy);
        if (decision.action === "retry") {
          await this.sleep(decision.delayMs);
          continue;
        }
        if (decision.action === "paused") {
          return {
            status: "paused",
            reason: decision.reason,
            retryAfterMs: decision.retryAfterMs,
            attempts: attempt,
          };
        }
        return { status: "exhausted", attempts: attempt, lastError: error };
      }
    }
  }

  /**
   * Trace persistence must never decide a claim's fate: a failing sink
   * (full disk, locked traces/ directory) is reported loudly but neither
   * discards a successful result nor abandons the retry loop — that would
   * be exactly the silent claim loss the escalation design forbids.
   */
  private async writeTrace<K extends JobKind>(
    job: JobRequest<K>,
    backend: string,
    attempt: number,
    startedAt: string,
    finishedAt: string,
    outcome:
      { model: string; result: unknown } | { model: null; error: AdapterError },
  ): Promise<void> {
    const envelope: TraceEnvelope = {
      trace_id: this.generateTraceId(),
      method: job.kind,
      params: job.input,
      backend,
      model: outcome.model,
      prompt_version: job.prompt.version,
      prompt_sha256: job.prompt.template_sha256,
      attempt,
      started_at: startedAt,
      finished_at: finishedAt,
      ...("result" in outcome
        ? { result: outcome.result }
        : {
            error: {
              kind: outcome.error.kind,
              name: outcome.error.name,
              message: outcome.error.message,
            },
          }),
    };
    try {
      await this.options.traceSink.write(job.projectDir, envelope);
    } catch (error) {
      console.warn(
        `adapter trace for ${job.kind} attempt ${attempt} could not be persisted`,
        error,
      );
    }
  }
}

function stampOutput<K extends JobKind>(
  kind: K,
  output: JobIO[K]["output"],
  backend: string,
  model: string,
  at: string,
): StampedOutput<K> {
  if (kind === "attribution") {
    // backend/model/at come from code and the shared clock read — never from
    // the LLM; `at` doubles as the judgment↔trace correlation key.
    return {
      ...(output as JobIO["attribution"]["output"]),
      backend,
      model,
      at,
    } as StampedOutput<K>;
  }
  return output as StampedOutput<K>;
}
