import { z } from "zod";

/**
 * Result of the repair job: an evidence-backed reformulation proposal for a
 * complained claim (GenAudit-style correction). The proposal is only ever a
 * suggestion — accepting it is a human adjudication step in a later epic.
 */
export const RepairOutput = z.strictObject({
  suggested_text: z.string().min(1),
  reasoning: z.string().min(1),
  /** Per-evidence excerpt corrections (verdict-driven repair, prompt
   * v1.1.0): for a stage-1 quote failure the meaningful repair is the
   * wording the frozen document actually contains, not a reformulated
   * claim — a wording-only "repair" would re-fail the same quote check and
   * loop straight back to adjudication. Optional and absent from
   * v1.0.0-era outputs, which stay valid against this widened schema. */
  evidence_repairs: z
    .array(
      z.strictObject({
        evidence_id: z.string().min(1),
        corrected_excerpt: z.string().min(1),
      }),
    )
    .min(1)
    .optional(),
});
export type RepairOutput = z.infer<typeof RepairOutput>;
