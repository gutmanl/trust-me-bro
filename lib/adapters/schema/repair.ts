import { z } from "zod";

/**
 * Result of the repair job: an evidence-backed reformulation proposal for a
 * complained claim (GenAudit-style correction). The proposal is only ever a
 * suggestion — accepting it is a human adjudication step in a later epic.
 */
export const RepairOutput = z.strictObject({
  suggested_text: z.string().min(1),
  reasoning: z.string().min(1),
});
export type RepairOutput = z.infer<typeof RepairOutput>;
