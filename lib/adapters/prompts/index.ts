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
  // Like rubric below, the attribution template version is NOT selected from
  // here in production anymore: the rule set's own
  // `attribution_template_version` (rubric-rules.ts) decides. This constant
  // therefore stays at 1.1.0 rather than following the newest template — that
  // is what makes "no unpinned production path" true by construction, and it
  // keeps the login probe (whose output is discarded), the fixtures and
  // scripts/adapter-smoke.ts on a template that has been exercised in
  // production. Bumping it would re-create the global flip for any future
  // call site that forgets the version argument, which is exactly the defect
  // the per-project pin exists to remove. Same reasoning, same precedent:
  // rubric stayed at 1.0.0 when v1.1.0 shipped.
  attribution: "1.1.0",
  // The rubric template version is NOT selected from here in production:
  // the rule set's own `prompt_template_version` (rubric-rules.ts) decides,
  // so a project pinned to se-evidence-rubric-v1 keeps the v1.0.0 prompt.
  // This default only serves direct renderPromptForJob calls in tests.
  rubric: "1.0.0",
  // 1.1.0 (verdict-driven repair): the critique carries an origin (human
  // complaint / machine verdict / failed quote), machine origins are framed
  // as unconfirmed, and a stage-1 critique may return per-evidence
  // corrected excerpts. Repair is deliberately NOT per-project pinned:
  // proposals are never persisted as prose vintage — the accepted wording
  // lands in the history with its own provenance — so the newest template
  // is always the right one.
  // 1.2.0: the input carries the anchored briefing paragraph and the model
  // may return `briefing_repair`, a rewrite of that one passage carrying
  // the repaired assertion — accepted only ever as an audited briefing
  // revision, never applied silently.
  // 1.2.1: pins the atomicity rule — `suggested_text` is exactly one
  // declarative sentence, meta-commentary goes into `reasoning`. 1.2.0
  // proposals could bundle a second sentence, which the apply gate
  // (`isAtomicClaimText`) then rejected — a suggestion that can never
  // be accepted.
  repair: "1.2.1",
  relevance: "1.0.0",
  // 1.1.0: the already-detected spans are reported too, with their title,
  // authors and year and the identifier echoed back. 1.0.0 told the model to
  // skip them, so a citation whose title and identifier share one sentence
  // reached the scan with no title — and the identity cross-check, which
  // compares a resolved identifier against the title the briefing claims for
  // it, cannot run without one. Only footnote-style citations were checked.
  // 1.1.1: resolves 1.1.0's contradiction with the output schema, caught by
  // recording against the real claude CLI: "omit what you cannot read"
  // collided with `authors` being required (a parenthetical citation names
  // none — the schema now defaults it) and with "omit the title" (a
  // titleless already-detected citation is now not reported at all, and a
  // prose citation takes the briefing's own wording as its title).
  reference_parse: "1.1.1",
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
        briefing_paragraph_json: json(typed.briefing_paragraph),
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
