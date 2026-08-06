import type {
  AttributionInput,
  ExtractionInput,
  JobIO,
  JobKind,
  RenderedPrompt,
  RepairInput,
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
  extraction: "1.0.0",
  attribution: "1.0.0",
  rubric: "1.0.0",
  repair: "1.0.0",
};

const json = (value: unknown): string => JSON.stringify(value, null, 2);

function buildVars(kind: JobKind, input: unknown): Record<string, string> {
  switch (kind) {
    case "extraction": {
      const typed = input as ExtractionInput;
      return {
        research_question: typed.research_question,
        briefing_text: typed.briefing_text,
        sources_json: json(typed.sources),
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
