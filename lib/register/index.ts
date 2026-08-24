/**
 * Public surface of the register core. Everything the app, pipeline and
 * export layers may use lives here. Deliberately NOT exported: the
 * ChainAppender and the raw state-machine engine — chain links and status
 * changes can only be produced inside a RegisterStore transaction, which is
 * what keeps the single-writer and append-only invariants structural.
 */
export { RegisterStore } from "./persistence/store";
export type {
  BriefingDraft,
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
// SC4 of the reviewer-triggered re-verification: the composed gate of the
// prechecked → auto_confirmed edge. Exported so the verification pipeline
// mirrors the SAME composition when it picks the edge instead of scanning
// the history a second time in its own words.
export { autoConfirmableWithoutPriorHumanConfirmation } from "./statemachine/transitions";
// RERUN-02: the widened `pending_adjudication → recheck_required` gate,
// exported for the SAME reason as the two predicates above — the re-check
// selection must ask the gate whether a queued claim qualifies instead of
// restating its condition, so it can never offer the reviewer a claim the
// transition would then refuse.
export { machineParkedInAdjudication } from "./statemachine/transitions";
// CR-01: the invariant "admitted into recheck_required ⇒ able to leave it".
// Exported for the same reason as the gate above — the re-check selection
// must ask the table whether a claim can come back out, instead of
// restating the exit edge's condition and drifting from it. A claim that
// fails this gate has zero outgoing edges once admitted, permanently.
export { canLeaveRecheck } from "./statemachine/transitions";
export {
  latestJudgmentPerBackend,
  resolveEvidenceRelation,
} from "./statemachine/divergence";
export type { TransitionRequest } from "./statemachine/engine";
export type { BriefingRenderContext } from "./projection/render-briefing";
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
// TMB-24/workbench epic: the shared verbatim-quote normal form and paragraph
// split, single-sourced here so stage 1's existence check, the extraction
// pipeline and this barrel's own briefing-view projection can never diverge.
export {
  containsNormalized,
  normalizeForSearch,
  splitBriefingParagraphs,
} from "./text/normalize";
// Anchor auto-repair: the bounded fuzzy second line behind the exact
// containment check — pure, threshold-gated, shared so the sweep and any
// display advisory use one notion of "near-verbatim".
export {
  FUZZY_REANCHOR_THRESHOLD,
  findFuzzyParagraph,
  quoteContainmentScore,
} from "./text/similarity";
// Stage 1's second line: containment across bounded interpolated material
// (a copyright block or figure caption the PDF extraction emitted
// mid-sentence). Still verbatim — only contiguity is relaxed.
export {
  MAX_INTERRUPTIONS,
  MAX_INTERRUPTION_CHARS,
  MIN_FRAGMENT_CHARS,
  findInterrupted,
} from "./text/interrupted";
export type { InterruptedMatch } from "./text/interrupted";
export * from "./schema";
