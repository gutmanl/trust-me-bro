import type { Backend, InvokeResult } from "../../core/contracts";
import type { JobIO, JobKind, JobRequest } from "../../core/jobs";

/**
 * In-memory backend for tests: covers all four job types with schema-valid
 * canned outputs, supports per-kind overrides and a scripted failure
 * sequence, and records every received job. It exercises exactly the same
 * orchestrator path as the CLI backends, so retry, tracing and concurrency
 * are testable without spawning processes.
 */

const DEFAULT_OUTPUTS: { [K in JobKind]: JobIO[K]["output"] } = {
  extraction: {
    claims: [
      {
        text: "Mock-Claim aus dem Briefing.",
        claim_type: "quantitativer_einzelbefund",
        briefing_anchor: "p1",
        evidence: [
          {
            source_id: "src_mock",
            locator: { page: 1 },
            verbatim_excerpt: "Mock-Auszug aus der eingefrorenen Quelle.",
          },
        ],
      },
    ],
  },
  attribution: {
    relation_type: "stuetzt",
    confidence: 0.9,
    reasoning: "Mock-Urteil: Auszug und Claim stimmen überein.",
  },
  rubric: {
    calibration_result: "lizenziert",
    reasoning: "Mock-Vorbewertung: Mindestevidenz der Rubrik liegt vor.",
  },
  repair: {
    suggested_text: "Mock-Vorschlag einer abgeschwächten Formulierung.",
    reasoning: "Mock-Begründung des Reparaturvorschlags.",
  },
};

export interface MockBackendOptions {
  readonly id?: string;
  readonly model?: string;
  /** Replace the canned output for individual job kinds. */
  readonly overrides?: Partial<{ [K in JobKind]: JobIO[K]["output"] }>;
  /**
   * Consumed one entry per invoke: an Error is thrown, "ok" answers
   * normally. After the script is exhausted, every call answers normally.
   */
  readonly script?: ReadonlyArray<Error | "ok">;
}

export interface MockBackend extends Backend {
  /** Every job received, in call order. */
  readonly calls: ReadonlyArray<JobRequest>;
}

export function createMockBackend(
  options: MockBackendOptions = {},
): MockBackend {
  const {
    id = "mock",
    model = "mock-1",
    overrides = {},
    script = [],
  } = options;
  const calls: JobRequest[] = [];
  const remainingScript = [...script];
  return {
    id,
    calls,
    async invoke<K extends JobKind>(
      job: JobRequest<K>,
    ): Promise<InvokeResult<K>> {
      calls.push(job);
      const step = remainingScript.shift();
      if (step instanceof Error) {
        throw step;
      }
      const output =
        (overrides[job.kind] as JobIO[K]["output"] | undefined) ??
        DEFAULT_OUTPUTS[job.kind];
      return { output, model };
    },
  };
}
