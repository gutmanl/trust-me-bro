import { z } from "zod";
import type { ZodType } from "zod";

import { Judgment } from "../../register";

/**
 * What an attribution job asks the LLM to judge — derived from the register's
 * Judgment sub-schema so the two can never drift apart. The provenance fields
 * `backend`, `model` and `at` are deliberately omitted: they are stamped by
 * the orchestrator from code, never self-reported by the model.
 */
export const AttributionOutput = Judgment.omit({
  backend: true,
  model: true,
  at: true,
});
export type AttributionOutput = z.infer<typeof AttributionOutput>;

/**
 * Selects the accepted attribution shape from the job's resolved prompt
 * template version. A pass-through today — every version answers in the
 * single-reasoning shape — so that `core/validate.ts` gains its version
 * dimension once, here and in `rubric.ts`, and 03-02 can add the two-layer
 * arm without touching the dispatch table at all.
 */
export function attributionOutputSchemaFor(
  _promptVersion: string,
): ZodType<AttributionOutput> {
  return AttributionOutput;
}
