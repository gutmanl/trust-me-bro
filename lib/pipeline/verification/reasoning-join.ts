/**
 * The pipeline's half of the two-layer prose contract (PROMPT-03): the model
 * writes three separate prose fields, and THIS module — not the model —
 * produces the single string the register persists as
 * `claim.calibration_reasoning` / a judgment's `reasoning`.
 *
 * Off every barrel: consumed by the stage-2/3 join sites only.
 */

/**
 * The three role markers, each carrying exactly ONE trailing space.
 *
 * These literals are DELIBERATELY DUPLICATED against
 * `REASONING_ROLE_MARKERS` in `app/projects/reasoning-paragraphs.ts`, which
 * owns the display side: `lib/**` may not import `app/**` (enforced by
 * `tests/architecture.test.ts` and by the ESLint `no-restricted-imports`
 * rule), so there is no module both tiers could share. The precedent is
 * `lib/register/projection/status-display.ts`, which documents its
 * duplication the same way.
 *
 * What makes the duplication a CONTRACT rather than a coincidence is the
 * round-trip test in `app/projects/reasoning-paragraphs.test.ts`: it feeds
 * this module's output through `splitReasoningParagraphs` and
 * `classifyReasoningParagraph` and asserts plain / caveat / technical. Change
 * a literal here and that test goes red on the other side of the boundary.
 *
 * `Jedoch:` in particular must NEVER be renamed or repurposed: it is
 * unchanged from prompt v1.1.0, and renaming it silently demotes every
 * caveat already stored — permanently, in a register that cannot be
 * rewritten. Byte evidence for the single trailing space: 33 of 33 real
 * stored caveat strings in the local registers use exactly
 * `"\n\n" + "Jedoch:" + " "`.
 */
const MARKER = {
  plain: "Einfach gesagt: ",
  caveat: "Jedoch: ",
  technical: "Technisch: ",
} as const;

export interface ReasoningRoles {
  readonly plain: string;
  /** `null` — never `""` — when there is no caveat. */
  readonly caveat: string | null;
  readonly technical: string;
}

/**
 * Joins the three prose roles into the persisted string: plain, then caveat,
 * then technical, separated by exactly two line feeds.
 *
 * The persisted ORDER is fixed and is independent of the order the prompt
 * template asks the model to emit the fields in. Display rank order and the
 * plain-layer-leads requirement decide it, so both prompt ordering variants
 * produce the same persisted layout — there is exactly one join, and there
 * must never be a second.
 *
 * A null caveat omits the paragraph ENTIRELY. Emitting a bare `Jedoch: `
 * would render an empty amber rule; the display-side filter would drop a
 * truly empty paragraph, but the join must not produce one in the first
 * place.
 */
export function joinReasoningRoles(roles: ReasoningRoles): string {
  return [
    MARKER.plain + roles.plain,
    roles.caveat === null ? null : MARKER.caveat + roles.caveat,
    MARKER.technical + roles.technical,
  ]
    .filter((paragraph): paragraph is string => paragraph !== null)
    .join("\n\n");
}

/** A pre-v1.2.0 model answer: one already-complete reasoning string. */
interface SingleReasoningOutput {
  readonly reasoning: string;
}

/** A v1.2.0-and-later model answer: three separate prose roles. */
interface TwoLayerReasoningOutput {
  readonly reasoning_plain: string;
  readonly caveat: string | null;
  readonly reasoning_technical: string;
}

/**
 * The ONE place in the codebase that branches on prose vintage — and it is
 * one branch, so neither join site has to know which vintage it is holding.
 *
 * The branch is on the PRESENCE OF A KEY, which is a fact about an object
 * that already passed the boundary schema for its own prompt version. It
 * must never become a function that infers the vintage from the CONTENT of a
 * string: sniffing markers out of prose is the position-based labelling the
 * display tier structurally forbids, and it would mislabel every reasoning
 * written before this milestone.
 *
 * The parameter is typed structurally so this module stays free of any
 * adapter-schema import.
 */
export function resolvePersistedReasoning(
  output: SingleReasoningOutput | TwoLayerReasoningOutput,
): string {
  if ("reasoning" in output) {
    return output.reasoning;
  }
  return joinReasoningRoles({
    plain: output.reasoning_plain,
    caveat: output.caveat,
    technical: output.reasoning_technical,
  });
}
