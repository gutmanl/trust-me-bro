/**
 * Public surface of the pipeline layer (epic TMB-3/TMB-4): the use-cases the
 * web layer calls. app/ imports exclusively from this barrel; module
 * internals stay internal.
 */
export * from "./errors";
export { decideClaim } from "./adjudication/decide";
export type { AdjudicationDecisionInput } from "./adjudication/decide";
export { buildAdjudicationQueue } from "./adjudication/queue";
export type { QueueEntry } from "./adjudication/queue";
export { applyRepair, discardClaim, proposeRepair } from "./repair/run-repair";
export type {
  ApplyRepairInput,
  ApplyRepairResult,
  RepairProposalOutcome,
} from "./repair/run-repair";
export type { ReEntryTarget } from "./repair/re-entry";
export type { RepairOutput } from "../adapters";
// The effort-timer reducer is deliberately NOT re-exported here: its consumer
// is a client hook, and the barrel transitively pulls node:fs modules. The
// hook deep-imports the pure module (lib/pipeline/adjudication/effort-timer)
// instead — the one sanctioned client-side deep import.
export { blobContentType, getProjectBlob } from "./blobs";
export type { ProjectBlob } from "./blobs";
// Pure display/derivation helpers of the register the web layer reuses.
export {
  formatLocator,
  latestJudgmentPerBackend,
  resolveEvidenceRelation,
} from "../register";
export { getBriefing, getBriefingViewModel, importBriefing } from "./briefing";
export type { ImportBriefingInput } from "./briefing";
export type {
  BriefingParagraphVM,
  BriefingViewModel,
  ClaimMarkerVM,
} from "../register";
// Register data types the web layer renders (type-only re-exports so app/
// code keeps importing from this one barrel).
export type {
  Claim,
  ClaimsRegister,
  ComplaintCategory,
  Evidence,
  HistoryEntry,
  Judgment,
  ProjectEvent,
  RoutingReason,
  Source,
} from "../register";
export { mintProjectId, slugify } from "./ids";
export {
  captureSource,
  freezeSourceSet,
  isSourceSetFrozen,
} from "./sources/capture";
export type { CaptureKind, CaptureSourceInput } from "./sources/capture";
export { formatCitation, toPlainCsl } from "./sources/csl";
export type { ManualMetadata } from "./sources/csl";
export {
  getExtractionRun,
  getExtractionState,
  startExtraction,
} from "./extraction/run-extraction";
export type {
  ExtractionDependencies,
  ExtractionRunSummary,
} from "./extraction/run-extraction";
export type {
  ExtractionState,
  ExtractionStatus,
} from "./extraction/derive-state";
export type { RunHandle, RunItemOutcome, RunProgressEvent } from "./runs/types";
export {
  getVerificationRun,
  getVerificationState,
  startVerification,
} from "./verification/run-verification";
export type {
  VerificationDependencies,
  VerificationItemOutcome,
  VerificationItemResult,
} from "./verification/run-verification";
export type {
  VerificationState,
  VerificationStatus,
} from "./verification/derive-state";
export {
  createProject,
  DEFAULT_ADJUDICATION_SAMPLE_RATE,
  DEFAULT_MAX_REPAIR_CYCLES,
  DEFAULT_RUBRIC_VERSION,
  DEFAULT_SECOND_OPINION,
  getChainVerification,
  getProjectSummary,
  listProjects,
  readProject,
} from "./projects";
export type { ChainVerificationResult } from "../register";
export type {
  BackendCli,
  CreateProjectInput,
  ProjectSummary,
} from "./projects";
