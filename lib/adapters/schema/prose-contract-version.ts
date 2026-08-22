import type { JobKind } from "../core/jobs";

/**
 * Which prose contract a given prompt TEMPLATE version speaks (PROMPT-01,
 * PROMPT-06).
 *
 * Two prompt vintages are live at once: the shipped `v1.0.0`/`v1.1.0`
 * templates ask for ONE `reasoning` string, the `v1.2.0` templates ask for
 * three separately named prose fields. The adapter boundary must accept
 * exactly the shape the template a job actually rendered asked for —
 * otherwise widening an output schema in place silently invalidates every
 * response from every project still pinned to an older template (three
 * failed attempts and an escalated claim per generation, presenting as a
 * model-compliance problem rather than as a code defect).
 *
 * This module is deliberately OFF every barrel: it is consumed by the two
 * schema modules and, through them, by `core/validate.ts` via a deep import.
 */

/**
 * The pre-two-layer template versions, per job kind. Verified against the
 * four files in `lib/adapters/prompts/{attribution,rubric}/` at plan time.
 *
 * This list can never legitimately GROW: a prompt template version is a file
 * that is never edited in place, so a behaviour change is always a NEW file
 * with a NEW version — and every new file speaks the current contract.
 */
export const SINGLE_REASONING_PROMPT_VERSIONS: Readonly<
  Partial<Record<JobKind, readonly string[]>>
> = Object.freeze({
  attribution: Object.freeze(["1.0.0", "1.1.0"]),
  rubric: Object.freeze(["1.0.0", "1.1.0"]),
});

/**
 * True when a job rendered at `promptVersion` must answer in the two-layer
 * prose shape.
 *
 * DEFAULTING DIRECTION — this is the whole design, do not invert it: an
 * UNRECOGNISED version resolves to the TWO-LAYER contract, never to the
 * legacy one. Because the legacy list above is closed by the
 * never-edit-a-version-in-place rule, a future `v1.3.0` inherits the current
 * contract with no maintenance step at all. Defaulting the other way would
 * re-create, one version later, exactly the failure this module exists to
 * prevent: a new template asking for the new shape while the boundary
 * quietly accepts the old one, letting a model escape the contract by
 * answering in a vintage nobody enumerated.
 *
 * The visible consequence, and it is wanted: a fixture carrying an invented
 * version string fails loudly against the strict contract instead of
 * silently skipping it. Fix such a fixture by naming a real template
 * version — NEVER by adding the invented string to the frozen table.
 */
export function usesTwoLayerProse(
  kind: JobKind,
  promptVersion: string,
): boolean {
  const singleReasoningVersions = SINGLE_REASONING_PROMPT_VERSIONS[kind];
  if (singleReasoningVersions === undefined) {
    // Kinds that never carried a two-layer prose contract at all.
    return false;
  }
  return !singleReasoningVersions.includes(promptVersion);
}
