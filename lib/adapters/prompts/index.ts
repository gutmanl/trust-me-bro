import type {
  AttributionInput,
  ExtractionInput,
  JobIO,
  JobKind,
  ReferenceParseInput,
  RelevanceInput,
  RenderedPrompt,
  RepairInput,
  ResearchInput,
  RubricInput,
} from "../core/jobs";
import { loadPromptTemplate } from "./load";
import { substitute } from "./render";

/**
 * Default template version per job kind. Templates are versioned files in
 * this directory (`<kind>/v<version>.md`); a changed prompt is a new version,
 * so RQ3 reruns can pin the exact prompt an earlier run used.
 */
export const CURRENT_PROMPT_VERSION: Record<JobKind, string> = {
  research: "1.0.0",
  // 1.1.0: pins the briefing_anchor counting convention (blank-line blocks,
  // headings included) — 1.0.0 left it open and models skipped the title,
  // anchoring every claim one paragraph too early.
  // 2.0.0 (workbench epic): the model never counts paragraphs anymore — it
  // quotes one (`anchor_quote`) and the pipeline resolves the position. The
  // pass is scoped to one source (or the unevidenced sweep) and reports
  // findings for already-known claims through `additional_evidence`.
  extraction: "2.0.0",
  // 1.1.0 (verdict redesign): reasoning in up to two German paragraphs, a
  // caveat paragraph starting "Jedoch:" — the UI splits on the blank line.
  attribution: "1.1.0",
  // The rubric template version is NOT selected from here in production:
  // the rule set's own `prompt_template_version` (rubric-rules.ts) decides,
  // so a project pinned to se-evidence-rubric-v1 keeps the v1.0.0 prompt.
  // This default only serves direct renderPromptForJob calls in tests.
  rubric: "1.0.0",
  repair: "1.0.0",
  relevance: "1.0.0",
  // 1.1.0: the already-detected spans are reported too, with their title,
  // authors and year and the identifier echoed back. 1.0.0 told the model to
  // skip them, so a citation whose title and identifier share one sentence
  // reached the scan with no title — and the identity cross-check, which
  // compares a resolved identifier against the title the briefing claims for
  // it, cannot run without one. Only footnote-style citations were checked.
  reference_parse: "1.1.0",
};

const json = (value: unknown): string => JSON.stringify(value, null, 2);

function buildVars(kind: JobKind, input: unknown): Record<string, string> {
  switch (kind) {
    case "research": {
      const typed = input as ResearchInput;
      return { research_question: typed.research_question };
    }
    case "extraction": {
      const typed = input as ExtractionInput;
      return {
        research_question: typed.research_question,
        briefing_text: typed.briefing_text,
        sources_json: json(typed.sources),
        target_source_json: json(typed.target_source),
        known_claims_json: json(typed.known_claims),
      };
    }
    case "attribution": {
      const typed = input as AttributionInput;
      return {
        claim_json: json(typed.claim),
        evidence_json: json(typed.evidence),
      };
    }
    case "rubric": {
      const typed = input as RubricInput;
      return {
        claim_json: json(typed.claim),
        evidence_json: json(typed.evidence),
        rubric_version: typed.rubric_version,
      };
    }
    case "repair": {
      const typed = input as RepairInput;
      return {
        claim_json: json(typed.claim),
        evidence_json: json(typed.evidence),
        complaint_json: json(typed.complaint),
      };
    }
    case "relevance": {
      const typed = input as RelevanceInput;
      return {
        research_question: typed.research_question,
        previous_research_question: typed.previous_research_question,
        claim_json: json(typed.claim),
      };
    }
    case "reference_parse": {
      const typed = input as ReferenceParseInput;
      return {
        briefing_text: typed.briefing_text,
        already_detected_json: json(typed.already_detected),
      };
    }
  }
}

/** Resolves a job's prompt template and interpolates the job input into it. */
export function renderPromptForJob<K extends JobKind>(
  kind: K,
  input: JobIO[K]["input"],
  version: string = CURRENT_PROMPT_VERSION[kind],
): RenderedPrompt {
  const template = loadPromptTemplate(kind, version);
  return {
    version,
    template_sha256: template.sha256,
    text: substitute(template.text, buildVars(kind, input)),
  };
}
