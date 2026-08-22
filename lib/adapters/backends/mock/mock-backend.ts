import type { Backend, InvokeResult } from "../../core/contracts";
import type {
  AttributionInput,
  JobIO,
  JobKind,
  JobRequest,
  RubricInput,
} from "../../core/jobs";
import { GERMAN_RULE_NAMES } from "../../schema/plain-contract";
import { usesTwoLayerProse } from "../../schema/prose-contract-version";

/**
 * In-memory backend for tests: covers every job kind with schema-valid
 * canned outputs, supports per-kind overrides and a scripted failure
 * sequence, and records every received job. It exercises exactly the same
 * orchestrator path as the CLI backends, so retry, tracing and concurrency
 * are testable without spawning processes.
 */

const DEFAULT_OUTPUTS: { [K in JobKind]: JobIO[K]["output"] } = {
  // Shaped like a real briefing — Markdown, one checkable statement per
  // paragraph, a cited source — so the demonstration path exercises the
  // extraction that runs on it afterwards instead of collapsing on
  // placeholder text.
  research: {
    briefing_markdown: [
      "# Mock-Briefing zur Forschungsfrage",
      "Der Einsatz von Musterwerkzeugen senkt die mediane Bearbeitungszeit " +
        'um 40 % (Musterstudie A, doi:10.0000/mock.1, S. 4): "Die mediane ' +
        'Bearbeitungszeit sank von 50 auf 30 Minuten je Aufgabe."',
      "Ein Einfluss auf die Ergebnisqualität ist in der herangezogenen " +
        "Literatur nicht belegt.",
    ].join("\n\n"),
  },
  // The anchor quote occurs verbatim in the research output above — the
  // pipeline resolves the paragraph by searching for it, so a canned quote
  // that does not occur there would land every demo claim unanchored.
  extraction: {
    claims: [
      {
        text: "Der Einsatz von Musterwerkzeugen senkt die mediane Bearbeitungszeit um 40 %.",
        claim_type: "quantitative_finding",
        anchor_quote: "senkt die mediane Bearbeitungszeit um 40 %",
        evidence: [
          {
            source_id: "src_mock",
            locator: { page: 1 },
            verbatim_excerpt: "Mock-Auszug aus der eingefrorenen Quelle.",
          },
        ],
      },
    ],
    additional_evidence: [],
  },
  attribution: {
    relation_type: "supports",
    confidence: 0.9,
    reasoning: "Mock-Urteil: Auszug und Aussage stimmen überein.",
  },
  rubric: {
    calibration_result: "licensed",
    reasoning:
      "Mock-Vorbewertung: Mindestbelege des Bewertungsschemas liegen vor.",
  },
  repair: {
    suggested_text: "Mock-Vorschlag einer abgeschwächten Formulierung.",
    reasoning: "Mock-Begründung des Reparaturvorschlags.",
  },
  relevance: {
    relevant: "yes",
    reasoning: "Mock-Einschätzung: Aussage betrifft die neue Recherchefrage.",
  },
  reference_parse: {
    references: [
      {
        raw_text: "Mock-Referenz im Fließtext (2025).",
        authors: ["Mock Author"],
        year: 2025,
        title: "Mock-Titel der referenzierten Arbeit",
      },
    ],
  },
};

/**
 * The two-layer prose answers, for jobs whose prompt version asks for them.
 *
 * The mock stands in for a model that follows the template it was handed. A
 * mock answering identically whatever the prompt asked would let every
 * v1.2.0 pipeline test validate a shape no v1.2.0 prompt ever requested —
 * the exact blind spot the version dimension exists to remove.
 *
 * Note that the mock does NOT call `validateJobOutput` itself; the
 * orchestrator's re-validation judges its output. A mismatch therefore
 * surfaces as a failing run rather than as a type error, which is precisely
 * how it would surface in production.
 */
const TWO_LAYER_OUTPUTS: Partial<{
  [K in JobKind]: (job: JobRequest<K>) => JobIO[K]["output"];
}> = {
  // Both answers are built FROM THE JOB rather than canned, because since
  // 03-02 two clauses of the contract are input-dependent
  // (`core/output-contract.ts`): the rubric answer must name the rule mapped
  // from THIS claim's type, and the attribution answer must quote THIS
  // evidence's excerpt. A canned string satisfies neither for any job but
  // the one it was written against — and a mock that cannot satisfy the
  // contract the real backend must satisfy is a mock that hides the
  // contract.
  rubric: (job) => ({
    calibration_result: "licensed",
    reasoning_technical:
      `Die ${GERMAN_RULE_NAMES[(job.input as RubricInput).claim.claim_type]} ` +
      "verlangt eine begutachtete Studie mit passendem Kontext; eine solche " +
      "liegt vor.",
    caveat: null,
    reasoning_plain:
      "Die Formulierung passt zu den Belegen. Die herangezogene Studie " +
      "deckt die Aussage in ihrem Kontext ab.",
  }),
  attribution: (job) => ({
    relation_type: "supports",
    confidence: 0.9,
    reasoning_plain:
      "Der Auszug trägt die Aussage. Der zitierte Abschnitt nennt sie " +
      "unmittelbar.",
    caveat: null,
    reasoning_technical:
      `Der Auszug lautet "${(job.input as AttributionInput).evidence.verbatim_excerpt.trim()}" ` +
      "und deckt die Aussage in ihrem Kontext ab.",
  }),
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
      const buildTwoLayer = usesTwoLayerProse(job.kind, job.prompt.version)
        ? (TWO_LAYER_OUTPUTS[job.kind] as
            ((request: JobRequest<K>) => JobIO[K]["output"]) | undefined)
        : undefined;
      const twoLayerDefault = buildTwoLayer?.(job);
      const output =
        (overrides[job.kind] as JobIO[K]["output"] | undefined) ??
        twoLayerDefault ??
        DEFAULT_OUTPUTS[job.kind];
      // Canned usage so the demo pipeline shows non-empty token accounting
      // (finding 6); deterministic, not derived from the prompt.
      return { output, model, usage: { inputTokens: 1200, outputTokens: 300 } };
    },
  };
}
