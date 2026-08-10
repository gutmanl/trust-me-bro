import type { ProjectConfig } from "../../register";
import type {
  ProcessRunOptions,
  ProcessRunResult,
  ProcessRunner,
} from "../core/contracts";
import type {
  AttributionInput,
  ClaimContext,
  EvidenceContext,
  ExtractionInput,
  JobIO,
  JobKind,
  JobRequest,
  ReferenceParseInput,
  RelevanceInput,
  RepairInput,
  ResearchInput,
  RubricInput,
} from "../core/jobs";
import { renderPromptForJob } from "../prompts";

/**
 * Shared test fixtures of the adapter layer (test-only, excluded from
 * coverage like the register's __fixtures__). One place to touch when a
 * context or input shape gains a field.
 */

export const exampleClaim: ClaimContext = {
  id: "clm_0001",
  text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
  claim_type: "quantitative_finding",
  briefing_anchor: "p12",
};

export const exampleEvidence: EvidenceContext = {
  id: "ev_0001",
  source_id: "src_meyer2025",
  source_type: "peer_reviewed_publication",
  locator: { page: 6, section: "4.2" },
  verbatim_excerpt: "…median review time dropped from 42 to 19 minutes (-55%)…",
};

export const exampleInputs: { [K in JobKind]: JobIO[K]["input"] } = {
  research: {
    research_question:
      "Reduzieren LLM-gestuetzte Code-Review-Werkzeuge die Reviewzeit messbar?",
  } satisfies ResearchInput,
  extraction: {
    research_question:
      "Reduzieren LLM-gestuetzte Code-Review-Werkzeuge die Reviewzeit messbar?",
    briefing_text: "Briefing-Absatz p12 …",
    sources: [{ id: "src_meyer2025", citation: "Meyer (2025), IEEE TSE" }],
  } satisfies ExtractionInput,
  attribution: {
    claim: exampleClaim,
    evidence: exampleEvidence,
  } satisfies AttributionInput,
  rubric: {
    claim: exampleClaim,
    evidence: [exampleEvidence],
    rubric_version: "se-evidence-rubric-v1",
  } satisfies RubricInput,
  repair: {
    claim: exampleClaim,
    evidence: [exampleEvidence],
    complaint: {
      categories: ["claim_not_derivable"],
      reason: "Der Auszug trägt die Verallgemeinerung nicht.",
    },
  } satisfies RepairInput,
  relevance: {
    research_question:
      "Wie wirken LLM-gestuetzte Code-Reviews auf die Codequalität?",
    previous_research_question:
      "Reduzieren LLM-gestuetzte Code-Review-Werkzeuge die Reviewzeit messbar?",
    claim: exampleClaim,
  } satisfies RelevanceInput,
  reference_parse: {
    briefing_text: "Briefing-Absatz p12 … siehe Meyer et al. (2025) …",
    already_detected: ["https://doi.org/10.1000/mock"],
  } satisfies ReferenceParseInput,
};

export function jobFor<K extends JobKind>(
  kind: K,
  projectDir = "C:/tmp/proj_x",
): JobRequest<K> {
  const input = exampleInputs[kind];
  return {
    kind,
    projectDir,
    input,
    prompt: renderPromptForJob(kind, input),
    timeoutMs: 90_000,
  };
}

export function attributionJob(): JobRequest<"attribution"> {
  return jobFor("attribution");
}

/** Records every call and answers with the given (partial) process result. */
export function fakeRunner(
  result: Partial<ProcessRunResult>,
): ProcessRunner & { calls: ProcessRunOptions[] } {
  const calls: ProcessRunOptions[] = [];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...result,
      };
    },
  };
}

export const exampleProjectConfig: ProjectConfig = {
  rubric_version: "se-evidence-rubric-v1",
  adjudication_sample_rate: 0.1,
  backends: {
    primary: { cli: "claude", model_family: "anthropic" },
    secondary: { cli: "codex", model_family: "openai" },
  },
};
