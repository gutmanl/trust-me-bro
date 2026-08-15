/**
 * `Backend` that replays recorded LLM outputs.
 *
 * The recording format is not invented here: `lib/adapters/trace/envelope.ts`
 * already writes one immutable `{method, params, result, prompt_sha256}`
 * file per adapter attempt into `<projectDir>/traces/`, and those files
 * already travel into `.tmb` export bundles. A recorded LLM cassette is that
 * envelope, narrowed to what a replay needs. The recorder therefore does not
 * instrument anything — it runs the real backend and harvests traces.
 *
 * Why this and not `createMockBackend`: the mock returns one canned answer
 * per job kind regardless of input, which is right for testing the
 * orchestrator's retry and tracing mechanics and wrong for testing what the
 * pipeline does with LLM output. The failure classes this corpus targets —
 * an extraction that cites a source id that was never captured, a reference
 * parse that reads a citation's title but misses its identifier — are
 * properties of the *content* of a specific answer to a specific input.
 * Keying on the input is the whole point.
 *
 * Replaying through a real `Orchestrator` (rather than calling the pipeline
 * with canned data) keeps output validation, retry and trace-writing in the
 * path under test, exactly as the mock backend's own doc comment argues.
 */
import type { Backend, InvokeResult } from "../../lib/adapters/core/contracts";
import type { JobKind, JobRequest } from "../../lib/adapters/core/jobs";
import type { LlmCassette } from "./cassette";
import { llmCassetteKey } from "./cassette";
import { loadLlmCassettes } from "./corpus-store";

export class LlmCassetteMissError extends Error {
  constructor(method: string, key: string, params: unknown) {
    super(
      `No LLM cassette for job kind "${method}"` +
        `\n  expected key: ${key}` +
        `\n  record it with: npm run corpus:record -- --llm` +
        `\n  input was: ${JSON.stringify(params).slice(0, 400)}`,
    );
    this.name = "LlmCassetteMissError";
  }
}

export interface ReplayBackend extends Backend {
  /** Every job received, in call order — mirrors MockBackend.calls so specs
   * written against one read the same as the other. */
  readonly calls: ReadonlyArray<JobRequest>;
  unusedKeys(): string[];
  /** Job kinds that were answered from `seed` because no recorded cassette
   * matched. Specs and the integrity report read this rather than guessing
   * how much of a run was real. */
  seedServed(): string[];
}

export interface ReplayBackendOptions {
  /** Backend id reported in judgments; defaults to the recorded one. */
  readonly id?: string;
  /**
   * Answers that win over everything, keyed by job kind. For the adversarial
   * outputs no real model can be asked to produce on demand — evidence
   * citing a source id that was never captured, a quote that is not in the
   * document. A spec using one is asserting about a specific hostile answer,
   * so it states it inline.
   */
  readonly overrides?: Partial<{ [K in JobKind]: unknown }>;
  /**
   * Fallback answers used ONLY when no recorded cassette matches the input.
   *
   * This is the LLM twin of the synthetic HTTP tier, and it is opt-in for
   * the same reason the cassette fetcher refuses to invent a 404: a silent
   * fallback would let a spec claim it replayed a real model while it
   * replayed a constant. Passing `seed` is a spec saying, in its own source,
   * "this output is authored until someone records one" — and
   * `seedServed()` reports it afterwards.
   *
   * Keying real recordings on the exact job input is what makes them
   * worth having; the seed exists so the suite runs before any exist.
   */
  readonly seed?: Partial<{ [K in JobKind]: unknown }>;
}

export function createReplayBackend(
  options: ReplayBackendOptions = {},
): ReplayBackend {
  const byKey = new Map<string, LlmCassette>();
  for (const cassette of loadLlmCassettes()) {
    byKey.set(cassette.key, cassette);
  }
  const calls: JobRequest[] = [];
  const used = new Set<string>();
  const seeded: string[] = [];

  return {
    id: options.id ?? "claude",
    calls,
    unusedKeys: () => [...byKey.keys()].filter((key) => !used.has(key)).sort(),
    seedServed: () => [...seeded],
    async invoke<K extends JobKind>(
      job: JobRequest<K>,
    ): Promise<InvokeResult<K>> {
      calls.push(job);

      const override = options.overrides?.[job.kind];
      if (override !== undefined) {
        return {
          output: override as InvokeResult<K>["output"],
          model: "replay-override",
        };
      }

      const key = llmCassetteKey(job.kind, job.input);
      const cassette = byKey.get(key);
      if (cassette) {
        used.add(key);
        return {
          output: cassette.result as InvokeResult<K>["output"],
          model: cassette.model ?? "replay-1",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }

      const seed = options.seed?.[job.kind];
      if (seed !== undefined) {
        seeded.push(job.kind);
        return {
          output: seed as InvokeResult<K>["output"],
          model: "replay-seed",
        };
      }

      throw new LlmCassetteMissError(job.kind, key, job.input);
    },
  };
}
