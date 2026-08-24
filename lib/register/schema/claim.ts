import { z } from "zod";

import {
  CalibrationResult,
  ClaimStatus,
  ClaimType,
  SupportDegree,
} from "./enums";
import { Evidence } from "./evidence";
import { HistoryEntry } from "./history";
import { ClaimId, IsoDateTime, ProjectId } from "./primitives";

/**
 * Provenance metadata of a claim: producing tool/model, extraction time and
 * search path (prerequisite for reconstructable provenance). For warm runs,
 * `origin_project_id` references the project a claim was adopted from.
 */
export const Provenance = z.strictObject({
  tool: z.string().min(1),
  model: z.string().min(1),
  extracted_at: IsoDateTime,
  search_path: z.string().min(1),
  origin_project_id: ProjectId.optional(),
});

/**
 * A superseded pre-check outcome, rotated out of the claim by a later
 * pre-check (reviewer-triggered re-verification). Carries the WHOLE
 * outcome rather than the reasoning alone: `calibration_result` and
 * `support_degree` are plain overwrites too, and reading the previous
 * verdict back out of the German `reason` prose is not a supported
 * reconstruction path, so anything omitted here is unrecoverable.
 * `superseded_at` is when the entry was rotated, not when it was judged
 * (documented extension, additive).
 */
export const CalibrationSnapshot = z.strictObject({
  support_degree: SupportDegree.optional(),
  calibration_result: CalibrationResult,
  calibration_reasoning: z.string().min(1).optional(),
  calibration_prompt_version: z.string().min(1).optional(),
  superseded_at: IsoDateTime,
});
export type CalibrationSnapshot = z.infer<typeof CalibrationSnapshot>;

/**
 * A claim with embedded evidence and history. `support_degree` is set by the
 * pre-verification stages and therefore optional early in the lifecycle.
 * Claims are never deleted: `history` documents every transition since
 * creation (at least the creating entry).
 */
export const Claim = z.strictObject({
  id: ClaimId,
  text: z.string().min(1),
  claim_type: ClaimType,
  status: ClaimStatus,
  support_degree: SupportDegree.optional(),
  calibration_result: CalibrationResult.optional(),
  /** The stage-3 verifier's German reasoning for `calibration_result`
   * (verdict redesign): up to two paragraphs separated by a blank line,
   * the second starting "Jedoch:" for a caveat — a display convention, not
   * separately modeled. Set together with `calibration_result` by the
   * pre-check; absent for claims judged before this field existed
   * (documented extension, additive). */
  calibration_reasoning: z.string().min(1).optional(),
  /** Version of the rubric TEMPLATE the adjacent `calibration_reasoning`
   * was written under (reviewer-triggered re-verification), so a reader can
   * tell which prose a verdict came from — a template version string
   * (`"1.1.0"` today, `"1.0.0"` in registers written before it), never the
   * rule-set name. Stamped WHEN the prose is written and never
   * reconstructed at rotation time from the project's current pin: wrong
   * metadata in an append-only register is worse than absent metadata.
   * Absent for claims judged before this extension (documented extension,
   * additive). */
  calibration_prompt_version: z.string().min(1).optional(),
  /** Superseded pre-check outcomes of earlier judgments
   * (reviewer-triggered re-verification), append-only in rotation order —
   * the same rotation idiom `previous_snapshots` uses for source revisions.
   * Deliberately uncapped: pruning it would destroy exactly the audit data
   * the field exists to keep. Absent for claims judged only once and for
   * claims from before this extension (documented extension, additive). */
  previous_calibrations: z.array(CalibrationSnapshot).optional(),
  briefing_anchor: z.string().min(1),
  /** Short verbatim phrase from the briefing paragraph the claim was
   * extracted from (workbench epic): the durable, quote-based anchor that
   * survives a briefing revision reordering paragraphs, unlike the
   * position-based `briefing_anchor` alone. Optional so pre-existing claims
   * without a captured quote stay representable (documented extension,
   * additive). */
  anchor_quote: z.string().min(1).optional(),
  provenance: Provenance,
  evidence: z.array(Evidence),
  history: z.array(HistoryEntry).min(1),
});
export type Claim = z.infer<typeof Claim>;
