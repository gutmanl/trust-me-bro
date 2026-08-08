import { z } from "zod";

/**
 * Result of a relevance job (Einschlägigkeitsprüfung, TMB-43): does an
 * adopted, already-verified claim bear on the NEW research question of a
 * warm run? Three-valued like the register's routing semantics — `unsicher`
 * routes to adjudication exactly like `nein`, the human stays the final
 * instance. Existence and attribution are deliberately NOT re-judged here.
 */
export const RelevanceOutput = z.strictObject({
  einschlaegig: z.enum(["ja", "nein", "unsicher"]),
  reasoning: z.string().min(1),
});
export type RelevanceOutput = z.infer<typeof RelevanceOutput>;
