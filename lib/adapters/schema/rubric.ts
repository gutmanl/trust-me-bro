import { z } from "zod";

import { CalibrationResult } from "../../register";

/**
 * Result of the rubric pre-assessment (stage 3): is the strength of the
 * claim's formulation licensed by its evidence? The result value reuses the
 * register's closed CalibrationResult enumeration; the reasoning documents
 * which rubric rule carried the assessment.
 */
export const RubricOutput = z.strictObject({
  calibration_result: CalibrationResult,
  reasoning: z.string().min(1),
});
export type RubricOutput = z.infer<typeof RubricOutput>;
