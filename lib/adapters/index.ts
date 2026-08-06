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
export type {
  Backend,
  Clock,
  ConcurrencyGate,
  InvokeResult,
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
  TraceSink,
} from "./core/contracts";
export { decideNextAttempt } from "./core/retry";
export type { AttemptDecision, RetryPolicy } from "./core/retry";
export { Orchestrator } from "./orchestrator/orchestrator";
export type { OrchestratorOptions } from "./orchestrator/orchestrator";
export { createProjectOrchestrator } from "./orchestrator/factory";
export type { ProjectOrchestratorOptions } from "./orchestrator/factory";
export type { RunOutcome, StampedOutput } from "./orchestrator/types";
export { TraceEnvelope } from "./trace/envelope";
export { fileTraceSink } from "./runtime/trace-sink";
export {
  createConcurrencyGate,
  getGlobalConcurrencyGate,
} from "./runtime/concurrency-gate";
export {
  AdapterError,
  AdapterOutputError,
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterValidationError,
  UnknownBackendError,
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
export { createClaudeBackend } from "./backends/claude/claude-backend";
export type { ClaudeBackendOptions } from "./backends/claude/claude-backend";
export { createCodexBackend } from "./backends/codex/codex-backend";
export type { CodexBackendOptions } from "./backends/codex/codex-backend";
export { resolveConfiguredBackends } from "./registry";
export type { ConfiguredBackends, RegistryOptions } from "./registry";
export { createMockBackend } from "./backends/mock/mock-backend";
export type {
  MockBackend,
  MockBackendOptions,
} from "./backends/mock/mock-backend";
