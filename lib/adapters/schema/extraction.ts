import { z } from "zod";

import { ClaimType, Locator, SourceId } from "../../register";

/**
 * Result of the extraction job: claims with their findings, as read from the
 * frozen briefing. Shapes reuse the register's vocabulary (ClaimType, Locator,
 * SourceId) but stay adapter-owned — ids and status are assigned later by the
 * pipeline via the register's creation gate, which also routes claims without
 * evidence to adjudication instead of dropping them.
 */
export const ExtractedEvidence = z.strictObject({
  source_id: SourceId,
  locator: Locator,
  verbatim_excerpt: z.string().min(1),
});
export type ExtractedEvidence = z.infer<typeof ExtractedEvidence>;

export const ExtractedClaim = z.strictObject({
  text: z.string().min(1),
  claim_type: ClaimType,
  briefing_anchor: z.string().min(1),
  evidence: z.array(ExtractedEvidence),
});
export type ExtractedClaim = z.infer<typeof ExtractedClaim>;

export const ExtractionOutput = z.strictObject({
  claims: z.array(ExtractedClaim),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;
