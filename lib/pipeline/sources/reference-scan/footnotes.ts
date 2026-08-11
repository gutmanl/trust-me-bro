import { cleanReferenceTitle } from "./reference-title";

/**
 * Markdown-footnote handling for the reference scan (reference auto-import).
 *
 * Real briefings (Elicit, Perplexity) cite each source TWICE: an inline link
 * with a marker in the prose ("… reduziert.[^1]") AND a footnote definition
 * with the title at the end ("[^1]: A Review of Research …"). The two are one
 * citation, joined only by the marker `[^1]`. Parsing the definitions lets the
 * scan (a) give an inline URL/DOI candidate the title from its footnote, and
 * (b) recognize the LLM's separate report of that footnote as the same source
 * — instead of suggesting the paper twice. Pure and deterministic.
 */

export interface FootnoteDefinition {
  /** The label inside `[^label]:`. */
  marker: string;
  /** The definition text, verbatim (the reference as written). */
  rawText: string;
  /** The cleaned title, for Crossref resolution and display. */
  title: string;
}

const DEFINITION = /^\[\^([^\]]+)\]:\s*(.+)$/;
const MARKER = /\[\^([^\]]+)\]/g;

/** Every `[^label]: …` definition line in the briefing. */
export function parseFootnoteDefinitions(
  briefingText: string,
): FootnoteDefinition[] {
  const definitions: FootnoteDefinition[] = [];
  for (const rawLine of briefingText.split(/\r?\n/)) {
    const match = DEFINITION.exec(rawLine.trim());
    if (match) {
      const rawText = match[2].trim();
      definitions.push({
        marker: match[1],
        rawText,
        title: cleanReferenceTitle(rawText),
      });
    }
  }
  return definitions;
}

/** Footnote marker labels referenced inline in a piece of text (`…[^1][^2]`). */
export function footnoteMarkersIn(text: string): string[] {
  return [...text.matchAll(MARKER)].map((match) => match[1]);
}
