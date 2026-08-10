import { z } from "zod";

/**
 * Result of a reference_parse job (TMB-52 reference auto-import): the
 * textual citations the regex channel (DOI/arXiv/URL pattern matching)
 * could NOT find in the briefing. This is structured EXTRACTION, like the
 * `extraction` job kind — not a judgment kind like `attribution`, `rubric`,
 * `repair` or `relevance` — so it deliberately carries NO `reasoning`
 * field. Do not "fix" this by adding one.
 */
export const ParsedReference = z.strictObject({
  raw_text: z.string().min(1),
  authors: z.array(z.string()),
  year: z.int().optional(),
  title: z.string().min(1),
  venue: z.string().optional(),
  doi: z.string().optional(),
  arxiv_id: z.string().optional(),
  url: z.string().optional(),
});
export type ParsedReference = z.infer<typeof ParsedReference>;

export const ReferenceParseOutput = z.strictObject({
  references: z.array(ParsedReference),
});
export type ReferenceParseOutput = z.infer<typeof ReferenceParseOutput>;
