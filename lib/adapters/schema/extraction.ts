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
  /** Short verbatim phrase copied from the briefing paragraph the claim
   * appears in — the pipeline resolves it to a paragraph anchor. */
  anchor_quote: z.string().min(1),
  evidence: z.array(ExtractedEvidence),
});
export type ExtractedClaim = z.infer<typeof ExtractedClaim>;

/**
 * Evidence a per-source pass found for a claim that already exists in the
 * register: the incremental extraction reports it here instead of
 * re-extracting the claim, so the pipeline can attach it to the known claim
 * (and pull that claim into Nachprüfung) rather than creating a duplicate.
 */
export const AdditionalEvidence = z.strictObject({
  /** Exact text of an already-known claim this evidence belongs to. */
  claim_text_match: z.string().min(1),
  evidence: ExtractedEvidence,
});
export type AdditionalEvidence = z.infer<typeof AdditionalEvidence>;

export const ExtractionOutput = z.strictObject({
  claims: z.array(ExtractedClaim),
  additional_evidence: z.array(AdditionalEvidence).default([]),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;
