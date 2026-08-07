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
export {
  latestJudgmentPerBackend,
  resolveEvidenceRelation,
} from "./statemachine/divergence";
export type { TransitionRequest } from "./statemachine/engine";
export { renderBriefing } from "./projection/render-briefing";
export { countClaimsByStatus } from "./projection/counts";
export { lastActivityAt } from "./projection/activity";
export { verifyChain } from "./chain/verify";
export type {
  ChainVerificationError,
  ChainVerificationResult,
} from "./chain/verify";
export { createBlobStore } from "./blobs/store";
export type { BlobRef, BlobStore } from "./blobs/store";
export * from "./schema";
