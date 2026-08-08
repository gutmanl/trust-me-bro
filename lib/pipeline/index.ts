/**
 * Public surface of the pipeline layer (epic TMB-3/TMB-4): the use-cases the
 * web layer calls. app/ imports exclusively from this barrel; module
 * internals stay internal.
 */
export * from "./errors";
export { decideClaim } from "./adjudication/decide";
export type { AdjudicationDecisionInput } from "./adjudication/decide";
export {
  buildAdjudicationQueue,
  filterQueue,
  sortQueue,
} from "./adjudication/queue";
export type { QueueEntry, QueueRoutingFilter } from "./adjudication/queue";
export { buildEvidenceDisplayMap } from "./adjudication/evidence-display";
export type { EvidenceDisplay } from "./adjudication/evidence-display";
export { buildTimeline } from "./timeline";
export type { TimelineEntry } from "./timeline";
export { applyRepair, discardClaim, proposeRepair } from "./repair/run-repair";
export type {
  ApplyRepairInput,
  ApplyRepairResult,
  RepairProposalOutcome,
} from "./repair/run-repair";
export type { ReEntryTarget } from "./repair/re-entry";
export type { RepairOutput } from "../adapters";
// Pure, node:fs-free modules consumed by CLIENT components deep-import past
// this barrel (which transitively pulls node:fs): the effort-timer reducer,
// the queue filter/sort helpers and the id minting. The allowlist is pinned
// by the app-boundary check in tests/architecture.test.ts.
export { getProjectBlob } from "./blobs";
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
  DEFAULT_RUBRIC_VERSION,
  DEFAULT_SECOND_OPINION,
  getChainVerification,
  getProjectSummary,
  listProjects,
  readProject,
} from "./projects";
// TMB-41: the three derived export files, standalone AND inside the bundle
// from the same builders (no drift possible). The pure build functions stay
// internal; the web layer sees only the per-project accessors.
export { getReferencesCsl } from "./export/references";
export { getProvDocument } from "./export/prov";
export { getTracesAggregate } from "./export/traces";
export type { TracesAggregate } from "./export/traces";
// TMB-39: the .tmb bundle download.
export { exportProjectBundle } from "./export/build-export";
export type { ExportBundleResult } from "./export/build-export";
export type { ChainVerificationResult } from "../register";
export type {
  BackendCli,
  CreateProjectInput,
  ProjectSummary,
} from "./projects";
