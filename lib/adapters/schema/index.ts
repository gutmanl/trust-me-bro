/**
 * Adapter-owned result schemas for the LLM job types. Attribution derives
 * from the register's Judgment sub-schema; extraction, rubric, repair,
 * relevance, reference_parse and research results exist only here — they
 * become register data through the pipeline's explicit transaction writes,
 * never by direct merge.
 */
export { AttributionOutput } from "./attribution";
export {
  ExtractedClaim,
  ExtractedEvidence,
  ExtractionOutput,
} from "./extraction";
export { RubricOutput } from "./rubric";
export { RepairOutput } from "./repair";
export { RelevanceOutput } from "./relevance";
export { ParsedReference, ReferenceParseOutput } from "./reference-parse";
export { ResearchOutput } from "./research";
