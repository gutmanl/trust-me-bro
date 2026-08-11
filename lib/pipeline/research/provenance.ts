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
 * in the register schema. The prefix is reserved — importBriefing rejects a
 * user-supplied tool name that starts with it — so a manually imported
 * briefing can never be mistaken for a generated one within this
 * installation. (A briefing carried in from an imported .tmb bundle can name
 * any tool it likes; the register binds no chain to an installation, so that
 * provenance claim is inherently unauthenticated — see importBriefing.)
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
