/**
 * Public surface of the adapter layer (epic TMB-2). Deliberately narrow:
 * prompt loading/interpolation internals stay private — callers render
 * prompts only through renderPromptForJob, so every prompt that reaches a
 * backend carries its template version and content hash for the trace.
 */
export type {
  AttributionInput,
  ClaimContext,
  EvidenceContext,
  ExtractionInput,
  JobIO,
  JobKind,
  JobRequest,
  RenderedPrompt,
  RepairInput,
  RubricInput,
  SourceContext,
} from "./core/jobs";
export type { Backend, Clock, InvokeResult } from "./core/contracts";
export {
  AdapterError,
  AdapterOutputError,
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterValidationError,
} from "./core/errors";
export type { AdapterErrorKind } from "./core/errors";
export {
  AttributionOutput,
  ExtractedClaim,
  ExtractedEvidence,
  ExtractionOutput,
  RepairOutput,
  RubricOutput,
} from "./schema";
export { CURRENT_PROMPT_VERSION, renderPromptForJob } from "./prompts";
export { createMockBackend } from "./backends/mock/mock-backend";
export type {
  MockBackend,
  MockBackendOptions,
} from "./backends/mock/mock-backend";
