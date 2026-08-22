import { z } from "zod";
import type { ZodType } from "zod";

import { Judgment } from "../../register";
import { plainLanguageContract } from "./plain-contract";
import { usesTwoLayerProse } from "./prose-contract-version";

/**
 * What an attribution job asks the LLM to judge — derived from the register's
 * Judgment sub-schema so the two can never drift apart. The provenance fields
 * `backend`, `model` and `at` are deliberately omitted: they are stamped by
 * the orchestrator from code, never self-reported by the model.
 *
 * FROZEN: two shipped template versions — attribution v1.0.0 and v1.1.0 —
 * describe exactly this three-key shape. Unlike rubric, where the global
 * default is v1.0.0, every EXISTING project renders attribution v1.1.0, so
 * this is not a legacy curiosity but the shape currently in production. No
 * plain-language contract is attached here on purpose: attaching one would
 * change behaviour for every existing project, retroactively, against a
 * prompt that never asked for it.
 */
export const SingleReasoningAttributionOutput = Judgment.omit({
  backend: true,
  model: true,
  at: true,
});
export type SingleReasoningAttributionOutput = z.infer<
  typeof SingleReasoningAttributionOutput
>;

/**
 * The go-forward attribution shape (attribution prompt v1.2.0 and later).
 *
 * `reasoning` is the ONE field consciously swapped out of the derivation: the
 * PIPELINE reconstructs the persisted string from the three separately named
 * prose fields, so the model never writes it.
 *
 * The omit of `backend`, `model` and `at` is UNCHANGED and is what keeps the
 * model from self-reporting provenance — the object stays strict, so a
 * response carrying any of them is rejected.
 *
 * `relation_type` is the FIRST KEY and must stay there. Under left-to-right
 * decoding, prose emitted after the verdict token cannot mechanically change
 * it — the safeguard dies the moment someone applies the classic "let it
 * reason before it answers" refactor.
 */
const TwoLayerAttributionOutput = Judgment.omit({
  backend: true,
  model: true,
  at: true,
  reasoning: true,
})
  .extend({
    reasoning_plain: z.string().min(1),
    // `null` means "no caveat". The empty string is rejected, and the field
    // is not optional: a response omitting it entirely fails the strict
    // object, so "there is no caveat" is always an explicit statement.
    caveat: z.string().min(1).nullable(),
    reasoning_technical: z.string().min(1),
  })
  .check(
    plainLanguageContract({
      verdictOf: (value) => value.relation_type,
      // An attribution job carries no rubric rule, so there is no rule name
      // to demand. The technical layer is anchored on the job's OWN
      // verbatim excerpt instead — an input-dependent clause, and therefore
      // one that lives in `core/output-contract.ts` rather than here.
      requireRuleName: false,
    }),
  );

export const AttributionOutput = TwoLayerAttributionOutput;

/**
 * The VALUE `AttributionOutput` is the contract new prose must satisfy; the
 * TYPE is everything the boundary may legitimately hand the pipeline while
 * two prompt vintages are live. The asymmetry is deliberate — widening the
 * type is what lets a v1.1.0-pinned project (which is every existing project)
 * keep working, while keeping the value bound to the go-forward object is
 * what keeps `Object.keys(AttributionOutput.shape)[0]` an assertion about the
 * CURRENT contract.
 */
export type AttributionOutput =
  z.infer<typeof TwoLayerAttributionOutput> | SingleReasoningAttributionOutput;

/**
 * Selects the accepted shape from the job's RESOLVED prompt template version.
 *
 * Deliberately NOT a schema-level alternation over the two shapes (zod's
 * union combinator): an alternation would accept the three-key response under
 * a v1.2.0 prompt, handing every model a one-word escape from the entire
 * plain-language contract. Partitioned by version, exactly one shape
 * validates under any one version.
 *
 * The prohibition is grep-verified, so this comment deliberately does not
 * spell the combinator call out.
 */
export function attributionOutputSchemaFor(
  promptVersion: string,
): ZodType<AttributionOutput> {
  return usesTwoLayerProse("attribution", promptVersion)
    ? TwoLayerAttributionOutput
    : SingleReasoningAttributionOutput;
}
