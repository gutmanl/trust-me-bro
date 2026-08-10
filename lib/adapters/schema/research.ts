import { z } from "zod";

/**
 * Result of the research job: the briefing this application will then
 * verify. Deliberately a plain Markdown document rather than a structured
 * claim list — the briefing has to be the same kind of artifact whether it
 * was written elsewhere and imported or produced here, or the two paths
 * would diverge at the very first step and the frozen original would mean
 * something different in each.
 *
 * The extraction job, running afterwards, is what turns it into claims.
 */
export const ResearchOutput = z.strictObject({
  /** Markdown, German, one checkable statement per paragraph. */
  briefing_markdown: z.string().min(1),
});
export type ResearchOutput = z.infer<typeof ResearchOutput>;
