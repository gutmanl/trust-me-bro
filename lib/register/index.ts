/**
 * Public surface of the register core. Everything the app, pipeline and
 * export layers may use lives here. Deliberately NOT exported: the
 * ChainAppender and the raw state-machine engine — chain links and status
 * changes can only be produced inside a RegisterStore transaction, which is
 * what keeps the single-writer and append-only invariants structural.
 */
export { RegisterStore } from "./persistence/store";
export type {
  CreateProjectParams,
  RegisterTransaction,
} from "./persistence/store";
export {
  ChainIntegrityError,
  CorruptRegisterError,
  RegisterIntegrityError,
  RegisterValidationError,
} from "./persistence/errors";
export {
  DecisionRequiredError,
  GateRejectedError,
  InvalidTransitionError,
} from "./statemachine/errors";
export { TRANSITIONS } from "./statemachine/transitions";
export type { GateResult } from "./statemachine/transitions";
export { isAtomicClaimText } from "./statemachine/atomicity";
// Exposed so the verification pipeline can decide WHICH edge to take and
// WHICH relation to persist without re-implementing the rules; the gates in
// the transition table remain the sole authority at commit time.
export { evaluateAutoConfirmation } from "./statemachine/auto-confirmation";
export { allExistenceChecksPassed } from "./statemachine/transitions";
export {
  latestJudgmentPerBackend,
  resolveEvidenceRelation,
} from "./statemachine/divergence";
export type { TransitionRequest } from "./statemachine/engine";
export { formatLocator, renderBriefing } from "./projection/render-briefing";
export {
  buildBriefingViewModel,
  CONFIRMED_STATUSES,
} from "./projection/briefing-view";
export type {
  BriefingParagraphVM,
  BriefingViewModel,
  ClaimMarkerVM,
} from "./projection/briefing-view";
export { countClaimsByStatus, countRepairCycles } from "./projection/counts";
export { lastActivityAt } from "./projection/activity";
// TMB-45: evaluation metrics as pure derivations over the register — the
// history is the single source, nothing is persisted.
export { computeProjectMetrics } from "./projection/metrics";
export type { ClaimMetricsRow, ProjectMetrics } from "./projection/metrics";
// F4 filter projection (plain CSL-JSON item), shared by source capture and
// the export epic's references.csl.json derivation.
export { toPlainCsl } from "./projection/csl";
export { verifyChain } from "./chain/verify";
export type {
  ChainVerificationError,
  ChainVerificationResult,
} from "./chain/verify";
// TMB-6: content-hash utilities and the chain tip for the export bundle's
// manifest — pure read-side helpers with no writer invariant to protect
// (unlike the ChainAppender, which stays internal).
export { sha256Hex } from "./chain/hash";
export { latestChainLink } from "./chain/appender";
export type { ChainLink } from "./chain/appender";
export { sha256FromBlobPath } from "./blobs/paths";
export { createBlobStore } from "./blobs/store";
export type { BlobRef, BlobStore } from "./blobs/store";
export * from "./schema";
