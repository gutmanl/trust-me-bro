/**
 * Provenance convention for a briefing this application researched itself.
 *
 * A leaf module on purpose: both the run use-case (which writes the value)
 * and the independence check (which reads it back) need it, and putting it
 * in either of them would make the two import each other in a cycle —
 * run-research imports the briefing freeze path, which in turn needs the
 * independence finding for the projection.
 */

/**
 * The exact format is binding, not cosmetic: the independence notice parses
 * the backend id back out of `briefing_import.tool`, which is a free string
 * in the register schema. A manually imported briefing keeps whatever tool
 * name the user gave and is therefore never mistaken for a generated one.
 */
export const RESEARCH_TOOL_PREFIX = "trustmebro-research/";

/** The backend id of a self-researched briefing, or undefined when the
 * briefing came from elsewhere. */
export function researchBackendOf(
  tool: string | undefined,
): string | undefined {
  if (tool === undefined || !tool.startsWith(RESEARCH_TOOL_PREFIX)) {
    return undefined;
  }
  const id = tool.slice(RESEARCH_TOOL_PREFIX.length).trim();
  return id.length > 0 ? id : undefined;
}
