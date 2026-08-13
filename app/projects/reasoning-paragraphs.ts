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

/** The caveat paragraph's marker, styled distinctly by the review UI. */
export function isCaveatParagraph(paragraph: string): boolean {
  return paragraph.startsWith("Jedoch:");
}
