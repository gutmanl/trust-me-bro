import type { z } from "zod";

import type {
  ClaimType,
  ComplaintCategory,
  Locator,
  SourceType,
} from "../../register";
import type { AttributionOutput } from "../schema/attribution";
import type { ExtractionOutput } from "../schema/extraction";
import type { ReferenceParseOutput } from "../schema/reference-parse";
import type { RelevanceOutput } from "../schema/relevance";
import type { RepairOutput } from "../schema/repair";
import type { ResearchOutput } from "../schema/research";
import type { RubricOutput } from "../schema/rubric";

/**
 * Job model of the adapter layer: the LLM verification steps of the concept
 * (extraction, attribution judgment, rubric pre-assessment, repair proposal,
 * the relevance check of warm runs since TMB-43, and — since TMB-52 — the
 * textual-citation parse of the reference auto-import) as data. A job is
 * stateless and self-contained — everything the backend needs, including the
 * rendered prompt, travels in the request, so any single call is
 * individually repeatable (divergence rule, RQ3 reruns).
 */
export type JobKind =
  | "research"
  | "extraction"
  | "attribution"
  | "rubric"
  | "repair"
  | "relevance"
  | "reference_parse";

type LocatorValue = z.infer<typeof Locator>;

/** Claim fields a job needs — a projection, never the live register object. */
export interface ClaimContext {
  readonly id: string;
  readonly text: string;
  readonly claim_type: ClaimType;
  readonly briefing_anchor: string;
}

/** Evidence fields a job needs, incl. the frozen verbatim excerpt. The
 * source type travels along so rubric jobs stay self-contained (the rubric
 * weighs source types) instead of relying on the CLI reading claims.json. */
export interface EvidenceContext {
  readonly id: string;
  readonly source_id: string;
  readonly source_type: SourceType;
  readonly locator: LocatorValue;
  readonly verbatim_excerpt: string;
}

/** A frozen source the extraction may attach findings to. */
export interface SourceContext {
  readonly id: string;
  /** Human-readable citation label, e.g. "Meyer (2025), IEEE TSE". */
  readonly citation: string;
}

/**
 * Initial research: produces the briefing that everything downstream then
 * verifies. The only job whose input is not already-frozen project
 * material — there is nothing frozen yet at this point.
 */
export interface ResearchInput {
  readonly research_question: string;
}

export interface ExtractionInput {
  readonly research_question: string;
  readonly briefing_text: string;
  readonly sources: readonly SourceContext[];
}

export interface AttributionInput {
  readonly claim: ClaimContext;
  readonly evidence: EvidenceContext;
}

export interface RubricInput {
  readonly claim: ClaimContext;
  readonly evidence: readonly EvidenceContext[];
  readonly rubric_version: string;
}

export interface RepairInput {
  readonly claim: ClaimContext;
  readonly evidence: readonly EvidenceContext[];
  /** The complaint that put the claim into contested — always at least one
   * category (multi-select of the adjudication dialog, TMB-35). */
  readonly complaint: {
    readonly categories: readonly ComplaintCategory[];
    readonly reason: string;
  };
}

/** Relevance check of a warm run (TMB-43): only the claim's bearing on the
 * NEW research question is judged — existence and attribution stand. */
export interface RelevanceInput {
  readonly research_question: string;
  /** The origin project's question, for contrast; "(nicht verfügbar)" when
   * the origin project cannot be read anymore. */
  readonly previous_research_question: string;
  readonly claim: ClaimContext;
}

/** Textual-citation extraction of a briefing (TMB-52 reference auto-import):
 * finds citations the regex channel (DOI/arXiv/URL pattern matching) could
 * NOT find. `already_detected` carries the regex channel's spans so the LLM
 * hunts only for OTHER citations instead of re-reporting them. */
export interface ReferenceParseInput {
  readonly briefing_text: string;
  readonly already_detected: readonly string[];
}

/**
 * Compile-time mapping job kind → input/output shapes. `Backend.invoke<K>`
 * indexes into this instead of switching over a union, so callers get the
 * exact result type per kind.
 */
export interface JobIO {
  research: { input: ResearchInput; output: ResearchOutput };
  extraction: { input: ExtractionInput; output: ExtractionOutput };
  attribution: { input: AttributionInput; output: AttributionOutput };
  rubric: { input: RubricInput; output: RubricOutput };
  repair: { input: RepairInput; output: RepairOutput };
  relevance: { input: RelevanceInput; output: RelevanceOutput };
  reference_parse: {
    input: ReferenceParseInput;
    output: ReferenceParseOutput;
  };
}

/** A prompt template resolved to concrete text, identified for the trace. */
export interface RenderedPrompt {
  readonly version: string;
  /** SHA-256 of the template file — attributes output changes to prompt
   * changes in RQ3 reruns, independent of the interpolated input. */
  readonly template_sha256: string;
  readonly text: string;
}

export interface JobRequest<K extends JobKind = JobKind> {
  readonly kind: K;
  /**
   * Absolute path of the frozen project state the backend may read.
   * Process-based adapters use it as the child process's working directory;
   * a later API-based adapter would read the same files in-process. No
   * upload or transport concept belongs in this contract.
   */
  readonly projectDir: string;
  readonly input: JobIO[K]["input"];
  readonly prompt: RenderedPrompt;
  readonly timeoutMs: number;
}
