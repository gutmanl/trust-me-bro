import { z } from "zod";
import type { ZodType } from "zod";

import { CalibrationResult } from "../../register";
import { plainLanguageContract } from "./plain-contract";
import { usesTwoLayerProse } from "./prose-contract-version";

/**
 * Result of the rubric pre-assessment (stage 3): is the strength of the
 * claim's formulation licensed by its evidence? The result value reuses the
 * register's closed CalibrationResult enumeration; the reasoning documents
 * which rubric rule carried the assessment.
 *
 * FROZEN: two shipped template versions — rubric v1.0.0 and v1.1.0 — describe
 * exactly this two-key shape, and every project pinned to one of them
 * answers in it. No plain-language contract is attached here on purpose:
 * attaching one would change behaviour for every existing project, retroactively,
 * against a prompt that never asked for it.
 */
export const SingleReasoningRubricOutput = z.strictObject({
  calibration_result: CalibrationResult,
  reasoning: z.string().min(1),
});
export type SingleReasoningRubricOutput = z.infer<
  typeof SingleReasoningRubricOutput
>;

/**
 * The go-forward rubric shape (rubric prompt v1.2.0 and later): three
 * separately named prose fields, joined into one persisted string by the
 * PIPELINE, never by the model.
 *
 * `calibration_result` is the FIRST KEY and must stay there. Under
 * left-to-right decoding, prose emitted after the verdict token cannot
 * mechanically change it — the safeguard dies the moment someone applies the
 * classic "let it reason before it answers" refactor.
 */
const TwoLayerRubricOutput = z
  .strictObject({
    calibration_result: CalibrationResult,
    reasoning_plain: z.string().min(1),
    // `null` means "no caveat". The empty string is rejected, and the field
    // is not optional: a response omitting it entirely fails the strict
    // object, so "there is no caveat" is always an explicit statement.
    caveat: z.string().min(1).nullable(),
    reasoning_technical: z.string().min(1),
  })
  .check(
    plainLanguageContract({
      verdictOf: (value) => value.calibration_result,
      requireRuleName: true,
    }),
  );

export const RubricOutput = TwoLayerRubricOutput;

/**
 * The VALUE `RubricOutput` is the contract new prose must satisfy; the TYPE
 * is everything the boundary may legitimately hand the pipeline while two
 * prompt vintages are live. The asymmetry is deliberate — widening the type
 * is what lets a v1.1.0-pinned project keep working, while keeping the value
 * bound to the go-forward object is what keeps
 * `Object.keys(RubricOutput.shape)[0]` an assertion about the CURRENT
 * contract.
 */
export type RubricOutput =
  z.infer<typeof TwoLayerRubricOutput> | SingleReasoningRubricOutput;

/**
 * Selects the accepted shape from the job's RESOLVED prompt template version.
 *
 * Deliberately NOT a schema-level alternation over the two shapes (zod's
 * union combinator): an alternation would accept the two-key response under
 * a v1.2.0 prompt, handing every model a one-word escape from the entire
 * plain-language contract. Partitioned by version, exactly one shape
 * validates under any one version.
 *
 * The prohibition is grep-verified, so this comment deliberately does not
 * spell the combinator call out.
 */
export function rubricOutputSchemaFor(
  promptVersion: string,
): ZodType<RubricOutput> {
  return usesTwoLayerProse("rubric", promptVersion)
    ? TwoLayerRubricOutput
    : SingleReasoningRubricOutput;
}
