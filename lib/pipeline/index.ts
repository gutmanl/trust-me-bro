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
// TMB-44: source revision on a frozen set.
export { reviseSource } from "./sources/revise";
export type { ReviseSourceInput, ReviseSourceResult } from "./sources/revise";
export { formatCitation, toPlainCsl } from "./sources/csl";
export type { ManualMetadata } from "./sources/csl";
// Reference auto-import: the pipeline cluster that scans a frozen briefing
// for cited works and lets the user selectively capture them. Internals
// (scanRegex, mergeCandidates, scoreMatch, buildCandidateReview, Crossref
// access, …) stay off this barrel — tests reach them via relative imports.
export {
  getReferenceScanRun,
  getReferenceScanState,
  startReferenceScan,
} from "./sources/reference-scan/run-reference-scan";
export type {
  ReferenceScanDependencies,
  ReferenceScanRunSummary,
} from "./sources/reference-scan/run-reference-scan";
export type {
  ReferenceScanState,
  ReferenceScanStatus,
} from "./sources/reference-scan/derive-state";
export {
  getReferenceCaptureRun,
  startReferenceCapture,
} from "./sources/reference-scan/run-reference-capture";
export type {
  ReferenceCaptureDependencies,
  ReferenceCaptureItemResult,
  ReferenceCaptureSelection,
} from "./sources/reference-scan/run-reference-capture";
export { getReferenceCandidates } from "./sources/reference-scan/read-candidates";
export type {
  CandidateMethod,
  DocumentUrlSource,
  ReferenceCandidate,
  ReferenceScanResult,
} from "./sources/reference-scan/schema";
export type { ReviewCandidate } from "./sources/reference-scan/review";
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
export type {
  RunControlState,
  RunHandle,
  RunItemOutcome,
  RunProgressEvent,
} from "./runs/types";
// TMB-50: cooperative run control, generic across run kinds; the runner
// itself stays internal (runs start only through the use-cases).
export { cancelRun, pauseRun, resumeRun } from "./runs/control";
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
// TMB-43: warm runs — follow-up project creation with claim adoption and
// the relevance check. Selection and state derivation stay internal.
export { createWarmRunProject } from "./warm/create-warm-run";
export type {
  CreateWarmRunInput,
  CreateWarmRunResult,
} from "./warm/create-warm-run";
export {
  getRelevanceRun,
  getRelevanceState,
  startRelevanceCheck,
} from "./warm/run-relevance";
export type {
  RelevanceDependencies,
  RelevanceItemOutcome,
  RelevanceItemResult,
} from "./warm/run-relevance";
export type { RelevanceState, RelevanceStatus } from "./warm/derive-state";
export {
  createProject,
  DEFAULT_ADJUDICATION_SAMPLE_RATE,
  DEFAULT_RUBRIC_VERSION,
  DEFAULT_SECOND_OPINION,
  getChainVerification,
  getProjectSummary,
  // TMB-51: lets the UI show the spike backend option only while the
  // feature flag and API key are present.
  isApiBackendEnabled,
  // TMB-54: the badge predicate for demo projects — every judgement in them
  // is canned, and the UI has to say so wherever they are shown.
  isDemoProject,
  listProjects,
  readProject,
} from "./projects";
// TMB-54: the example project, created on explicit request. The seeding
// actors and the scripted content stay internal.
export { createDemoProject, DEMO_PROJECT_ID } from "./demo";
// TMB-55: in-app initial research — the run use-case, its derived state and
// the run handle for the SSE stream. The prompt rendering, the provenance
// prefix parsing and the state derivation stay internal.
export {
  getResearchRun,
  getResearchState,
  startResearch,
} from "./research/run-research";
export type { ResearchRunSummary } from "./research/run-research";
export type { ResearchState, ResearchStatus } from "./research/derive-state";
// The independence finding the UI and the briefing projection both show.
export { getBriefingIndependence } from "./research/independence";
export type { BriefingIndependence } from "./research/independence";
// TMB-47: first-run setup — the gate predicate and the one mutation the
// /setup page performs. Identity internals stay behind lib/identity.
export { completeFirstRunSetup, isSetupComplete } from "./setup";
// Reference auto-import (Task 3b/Amendment 2): the Unpaywall installation
// setting — read accessor and the use-case that writes/clears it. Identity
// internals (the config-file writer, env precedence) stay behind
// lib/identity, same discipline as the setup use-cases above.
export { getUnpaywallSetting, setUnpaywallEmail } from "./setup";
export type { UnpaywallSetting } from "../identity";
// TMB-54 (D5): the workspace root, readable everywhere and settable during
// the first run only — the use-case itself refuses once projects exist.
export { getWorkspaceRootSetting, setWorkspaceRoot } from "./setup";
// TMB-54 (D6): the actor handle, readable and — unless the environment
// provides it — changeable from the installation settings page.
export { getActorHandleSetting, updateActorHandle } from "./setup";
// TMB-49: backend preflight for the status page and the panel notices; the
// probe mechanics and the run-precondition seam stay internal.
export { getBackendsHealth, runLoginProbe } from "./health";
// TMB-54 (D7): the same diagnosis without a project, so a user finds out
// whether a backend works BEFORE creating something with it.
export {
  getInstallationBackendsHealth,
  runInstallationLoginProbe,
} from "./health";
export type { ProjectBackendsHealth } from "./health";
export type { BackendHealth, ProbeResult, ProbeStatus } from "../adapters";
// TMB-46: per-project settings with chain-audited changes; the diff
// formatter stays internal.
export { updateProjectConfig } from "./config";
export type {
  UpdateProjectConfigInput,
  UpdateProjectConfigResult,
} from "./config";
// TMB-45: evaluation metrics — freshly computed from the register on every
// call, never persisted; the pure computation lives in the register's
// projection layer.
export { getProjectMetrics, metricsToCsv } from "./metrics";
export type { ClaimMetricsRow, ProjectMetrics } from "../register";
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
// TMB-40: bundle import under a user-chosen workspace name.
export { importProjectBundle } from "./export/import-bundle";
export type { ImportBundleResult } from "./export/import-bundle";
export type { ChainVerificationResult } from "../register";
export type {
  BackendCli,
  CreateProjectInput,
  ProjectSummary,
} from "./projects";
