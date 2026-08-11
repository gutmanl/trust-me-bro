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
