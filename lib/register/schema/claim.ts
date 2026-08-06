import { z } from "zod";

import { ClaimStatus, ClaimType, SupportDegree } from "./enums";
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
  briefing_anchor: z.string().min(1),
  provenance: Provenance,
  evidence: z.array(Evidence),
  history: z.array(HistoryEntry).min(1),
});
export type Claim = z.infer<typeof Claim>;
