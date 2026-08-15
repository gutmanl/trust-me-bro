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
 * How the existence check established the wording: contiguously
 * (`exact`), across bounded interpolated material such as a copyright
 * block or figure caption the PDF extraction emitted mid-sentence
 * (`interrupted`), or not at all (`none`). See the ExistenceCheck
 * sub-schema for why this is recorded on every outcome.
 */
export const ExistenceCheckMatch = z.enum(["exact", "interrupted", "none"]);
export type ExistenceCheckMatch = z.infer<typeof ExistenceCheckMatch>;

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
  /** Reference auto-import: brackets of a reference scan of the frozen
   * briefing, structurally parallel to the extraction/relevance brackets.
   * No capture bracket events exist alongside these — each capture is
   * self-durable (documented extension, additive). */
  "reference_scan_started",
  "reference_scan_completed",
  /** In-app initial research: brackets of a run that produces the briefing
   * from the research question, structurally parallel to the extraction and
   * reference-scan brackets (documented extension, additive). */
  "research_run_started",
  "research_run_completed",
  /** Briefing revision workflow (workbench epic): a re-import of the
   * briefing rotates the previous `briefing_import` into
   * `project.previous_briefings` and installs the new one, structurally
   * parallel to `source_set_revised` for sources (documented extension,
   * additive). */
  "briefing_revised",
  /** Manual anchor correction (workbench epic): appended when a claim's
   * `briefing_anchor`/`anchor_quote` is corrected by a human outside the
   * mechanical re-anchoring a briefing revision performs; carries the
   * before/after pair in `anchor_change` (documented extension, additive). */
  "claim_anchor_revised",
  /** Source work items (workbench epic): a capture attempt that failed —
   * manual or via reference import — recorded durably with its retryable
   * input in `capture_failure`, so the failure and its retry survive a
   * restart. A SUCCESSFUL capture appends no event of its own: the created
   * source entry (carrying `custom.capture_attempt_id`) is the durable
   * record, and its presence resolves any earlier failure of the same work
   * item (documented extension, additive). */
  "source_capture_failed",
  /** Source work items: a human dismissed a failed capture attempt —
   * carries the id in the event's `work_item_id` scalar and hides the
   * failure from the work-item list without erasing it from the chain. A
   * NEWER failure of the same work item reappears: dismissal is a judgment
   * about the recorded attempt, not about the work item forever
   * (documented extension, additive). */
  "source_capture_dismissed",
  /** Source correction (Korrektur der Quellenkennung): a source captured
   * under a wrong — typically hallucinated — identifier had its
   * bibliographic core replaced on the SAME source id, so all citing
   * evidence stays valid. Carries the full before/after core in
   * `identity_change`; the superseded core also moves to the source's
   * `custom.previous_identities`. Structurally distinct from
   * `source_set_revised` (content-only document rotation) so the timeline
   * can tell the two apart (documented extension, additive). */
  "source_identity_corrected",
  /** Automatic repair (automatische Reparatur): the system derived a
   * corrected identity for a failed capture or a wrongly identified
   * source — the `repair_action` payload carries the target, the derived
   * candidate, the confidence, and whether the fix was applied
   * automatically (`mode: "applied"`) or only suggested for one-click
   * confirmation (`mode: "suggested"`); durable so suggestions survive a
   * restart (documented extension, additive). */
  "source_repair_action",
  /** Automatic repair: a human dismissed an open repair suggestion, or a
   * suggestion was consumed by applying it — mirrors
   * `source_capture_dismissed`'s chain-order semantics, using the existing
   * `source_id`/`work_item_id` scalars to name the target (documented
   * extension, additive). */
  "source_repair_action_dismissed",
]);
export type ProjectEventType = z.infer<typeof ProjectEventType>;
