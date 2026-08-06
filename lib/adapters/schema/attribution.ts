import { z } from "zod";

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
