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
  // Omittable, parsing to []: the prompt tells the model never to fill a
  // field it cannot read off the text, and a parenthetical citation
  // "(Title, doi:…)" names no authors. Requiring the array here made an
  // obedient model's answer fail validation — the recorder caught the real
  // claude CLI omitting the field and the whole scan degrading to
  // regex-only. `title` stays required: a citation the model cannot title
  // is not reported at all (prompt v1.1.1), because a titleless reference
  // can neither enrich the identity cross-check nor be searched on
  // Crossref.
  authors: z.array(z.string()).default([]),
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
