/**
 * Splits a verifier's German reasoning into display paragraphs (verdict
 * redesign): the v1.1.0 prompts ask for up to two paragraphs separated by
 * a blank line, the second starting "Jedoch:" for a caveat. Old
 * single-paragraph reasoning yields a one-element array and renders
 * exactly as before.
 */
export function splitReasoningParagraphs(reasoning: string): string[] {
  return reasoning
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * The role a paragraph of a stored reasoning plays.
 *
 * `unmarked` is the explicit PRE-MARKER-CONVENTION state, not a degradation
 * to `plain`, and the distinction is the whole point. Every judgment written
 * before this milestone is one or two unmarked German paragraphs. A parser
 * that assigned tiers by POSITION — "first paragraph = plain" — would label
 * an existing purely technical paragraph as the simple summary; the reviewer
 * would then trust a specialist sentence as the plain layer and stop looking
 * for the real one. That is a silent, permanent degradation of audit value
 * across the entire existing corpus, introduced by a feature whose stated
 * purpose is legibility. Unmarked prose therefore renders with NO tier label
 * and NO styling — byte-identical to what it rendered as before.
 *
 * `Jedoch:` is unchanged from prompt v1.1.0 and must NEVER be renamed:
 * renaming it silently demotes every caveat already stored, permanently, in
 * a register that cannot be rewritten. `Einfach gesagt:` and `Technisch:`
 * are additive — prose carrying them arrives with the v1.2.0 prompts.
 */
export type ReasoningRole = "plain" | "caveat" | "technical" | "unmarked";

/**
 * The three literal markers, in display rank order. `verdict-glossary.test.ts`
 * asserts the prose glossary is a no-op on these same literals, so a fourth
 * marker added here without checking the glossary side fails on both sides.
 *
 * The EMITTING side duplicates these literals in
 * `lib/pipeline/verification/reasoning-join.ts`, because `lib/**` may not
 * import `app/**`. The round-trip test at the bottom of this file's test
 * module is what makes that duplication a contract: it joins over there and
 * classifies over here, so the two copies cannot drift apart silently.
 */
export const REASONING_ROLE_MARKERS = [
  "Einfach gesagt:",
  "Jedoch:",
  "Technisch:",
] as const;

const ROLE_BY_MARKER: Record<
  (typeof REASONING_ROLE_MARKERS)[number],
  ReasoningRole
> = {
  "Einfach gesagt:": "plain",
  "Jedoch:": "caveat",
  "Technisch:": "technical",
};

/**
 * Classifies ONE paragraph by anchored, exact literal prefix.
 *
 * The function receives a single paragraph and cannot see its position,
 * which is the structural way to make position-based classification
 * impossible rather than merely discouraged. Matching is `startsWith`
 * against the exact literal: no substring search (a marker appearing
 * mid-sentence is not a marker) and no case folding (preserving today's
 * rendering byte for byte is the requirement, and today's predicate was an
 * exact `startsWith("Jedoch:")`). Trimming is `splitReasoningParagraphs`'
 * job, not this function's.
 */
export function classifyReasoningParagraph(paragraph: string): ReasoningRole {
  for (const marker of REASONING_ROLE_MARKERS) {
    if (paragraph.startsWith(marker)) {
      return ROLE_BY_MARKER[marker];
    }
  }
  return "unmarked";
}

/**
 * Styling per role — subordination as visual hierarchy, never as
 * concealment. The technical layer sits in the SAME block, one line below
 * the layer above it, quieter; it is never moved behind a second
 * disclosure, because the auditable content (the rule name, the decisive
 * phrase) is the thing the reviewer must be able to read.
 *
 * `undefined` for `unmarked` is the machine-checkable form of "renders with
 * no tier label at all".
 *
 * `plain` is one step darker than the container, which says "read this
 * first" — a typographic lead, never a claim about reliability.
 */
export function reasoningRoleClassName(
  role: ReasoningRole,
): string | undefined {
  switch (role) {
    case "plain":
      return "text-slate-800";
    case "caveat":
      // Verbatim the rule both call sites carried before the classifier
      // existed; every caveat already stored under v1.1.0 depends on it.
      return "border-l-2 border-amber-300 pl-2 text-amber-800";
    case "technical":
      return "border-l border-slate-200 pl-2 text-[11px] text-slate-500";
    case "unmarked":
      return undefined;
  }
}
