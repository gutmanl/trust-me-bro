import { z } from "zod";

/**
 * Result of a relevance job (relevance check, TMB-43): does an
 * adopted, already-verified claim bear on the NEW research question of a
 * warm run? Three-valued like the register's routing semantics — `uncertain`
 * routes to adjudication exactly like `no`, the human stays the final
 * instance. Existence and attribution are deliberately NOT re-judged here.
 */
export const RelevanceOutput = z.strictObject({
  relevant: z.enum(["yes", "no", "uncertain"]),
  reasoning: z.string().min(1),
});
export type RelevanceOutput = z.infer<typeof RelevanceOutput>;
