import { z } from "zod";

/**
 * Closed enumerations of the claims.json field schema. Values are English
 * identifiers mapped one-to-one to the German terms of the concept chapter
 * (file format appendix: the mapping is one-to-one and normative).
 */

/**
 * Claim lifecycle per the status model table in the concept chapter.
 * `recheck_required` (TMB-44) extends the ratified nine-status
 * model: a source revision invalidates the machine determinations that
 * referenced the old wording, so settled claims re-enter the verification
 * cascade instead of silently keeping a verdict about a text that no
 * longer exists (documented extension, additive).
 */
export const ClaimStatus = z.enum([
  "captured",
  "existence_checked",
  "prechecked",
  "auto_confirmed",
  "pending_adjudication",
  "confirmed",
  "contested",
  "revised",
  "discarded",
  "recheck_required",
]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/** Claim classification steering the evidence rubric (SE-Evidenz-Rubrik). */
export const ClaimType = z.enum([
  "quantitative_finding",
  "comparative_statement",
  "effectiveness_statement",
  "recommendation",
]);
export type ClaimType = z.infer<typeof ClaimType>;

/**
 * Four-level support degree per SemanticCite; kept in English as in the
 * originating scheme (and the appendix example).
 */
export const SupportDegree = z.enum([
  "supported",
  "partially_supported",
  "unsupported",
  "uncertain",
]);
export type SupportDegree = z.infer<typeof SupportDegree>;

/** Relation of one piece of evidence to its claim (Artefaktmodell). */
export const RelationType = z.enum([
  "supports",
  "partially_supports",
  "contradicts",
  "not_relevant",
]);
export type RelationType = z.infer<typeof RelationType>;

/** Source typing per the MLR-informed rubric weighting (Artefaktmodell). */
export const SourceType = z.enum([
  "peer_reviewed_publication",
  "preprint",
  "grey_literature",
  "vendor_documentation",
]);
export type SourceType = z.infer<typeof SourceType>;

/** Result of the deterministic existence check (stage 1). */
export const ExistenceCheckStatus = z.enum(["passed", "failed"]);
export type ExistenceCheckStatus = z.infer<typeof ExistenceCheckStatus>;

/**
 * Complaint categories of the adjudication dialog, translating the error
 * taxonomy into reviewer language (concept chapter, Adjudikations-Interface).
 * The mandatory free-text justification for "other" is enforced by the
 * adjudication dialog (later epic); the register only requires the generic
 * non-empty reason.
 */
export const ComplaintCategory = z.enum([
  "wording_not_in_source",
  "claim_not_derivable",
  "taken_out_of_context",
  "source_not_trustworthy",
  "source_outdated",
  "other",
]);
export type ComplaintCategory = z.infer<typeof ComplaintCategory>;

/**
 * Outcome of the stage-3 calibration check (SE-Evidenz-Rubrik): is the
 * strength of the formulation licensed by the evidence? The concept chapter
 * names a rubric complaint as a routing condition to adjudication; the field
 * schema of the format appendix left the outcome unmodeled, so this enum is
 * a documented extension introduced with the register core.
 *
 * `pending_adjudication` is intentionally the same value as the ClaimStatus
 * member of the same name: a rubric complaint routes the claim into
 * adjudication, so the calibration outcome and the resulting claim status
 * are the same concept observed from two angles, not a coincidence.
 */
export const CalibrationResult = z.enum([
  "licensed",
  "weakened",
  "pending_adjudication",
]);
export type CalibrationResult = z.infer<typeof CalibrationResult>;

/**
 * Structured routing reason of a transition INTO `pending_adjudication` (TMB-5,
 * ratified 08.08.2026): the queue filters and groups by this field instead of
 * parsing free-text reasons. Optional on history entries — entries from
 * before this extension (and non-routing transitions) simply lack it.
 */
export const RoutingReason = z.enum([
  "no_evidence",
  "existence_check_failed",
  "divergence",
  "negative_precheck",
  "spot_check",
  "escalated",
  /** TMB-43: an adopted claim's relevance to the follow-up question was
   * judged negative or uncertain by the relevance check of a warm run. */
  "negative_relevance",
]);
export type RoutingReason = z.infer<typeof RoutingReason>;

/**
 * Project-wide events without a claim reference (file format appendix).
 * `verification_run_started`/`verification_run_completed` bracket a
 * TMB-4 verification run; the extraction bracket keeps its own pair so each
 * feature's run state derives from its own events structurally instead of
 * sniffing reason strings (documented extension, additive).
 */
export const ProjectEventType = z.enum([
  "project_created",
  "briefing_imported",
  "source_set_frozen",
  "source_set_revised",
  "batch_run_started",
  "batch_run_completed",
  "verification_run_started",
  "verification_run_completed",
  /** TMB-43: brackets of the relevance check of a warm run, structurally
   * parallel to the extraction/verification brackets. */
  "relevance_run_started",
  "relevance_run_completed",
  /** TMB-46: a config change; the event carries the before/after pair in
   * `config_change` (documented extension, additive). */
  "config_changed",
  /** State-root extension (review fix S-01): auto-appended by the store when
   * a transaction changed register content without minting any entry of its
   * own (e.g. a source capture), so the changed content state is committed
   * to the chain instead of silently outdating the last state root
   * (documented extension, additive). */
  "content_updated",
]);
export type ProjectEventType = z.infer<typeof ProjectEventType>;
