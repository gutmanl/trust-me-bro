import { z } from "zod";

import { IsoDateTime, SourceType } from "../../../register";

/**
 * Pipeline-owned blob shape of the reference scan (reference auto-import):
 * this is NOT part of the register's field schema — it lives in the content-
 * addressed blob the `project.reference_scan` pointer addresses, validated
 * on write (run-reference-scan.ts) AND on read (read-candidates.ts), so a
 * hand-edited or truncated blob is caught instead of silently misread.
 */

/** Channel that resolved a candidate with an identifier of its own — kept
 * distinct from `ReferenceCandidate.method`, which additionally allows
 * "unresolved" for citations no channel could pin down. */
export const CandidateMethod = z.enum([
  "doi",
  "arxiv",
  "url",
  "crossref_title",
]);
export type CandidateMethod = z.infer<typeof CandidateMethod>;

export const ReferenceCandidate = z.strictObject({
  /** Stable deterministic hash of (method, normalized identifier | raw_text)
   * — see candidate.ts's candidateId(). */
  candidate_id: z.string().min(1),
  raw_text: z.string().min(1),
  method: z.enum(["doi", "arxiv", "url", "crossref_title", "unresolved"]),
  doi: z.string().optional(),
  arxiv_id: z.string().optional(),
  url: z.string().optional(),
  authors: z.array(z.string()).optional(),
  year: z.int().optional(),
  title: z.string().optional(),
  venue: z.string().optional(),
  match_score: z.number().min(0).max(1).optional(),
  /** True when Crossref could not be reached/answered at all for this
   * citation (network error, non-200, exhausted 429 retry) — distinct from
   * "Crossref answered but nothing scored above the floor". */
  crossref_unavailable: z.boolean().optional(),
  suggested_source_type: SourceType,
});
export type ReferenceCandidate = z.infer<typeof ReferenceCandidate>;

export const ReferenceScanResult = z.strictObject({
  scanned_at: IsoDateTime,
  method: z.enum(["regex", "regex+llm"]),
  candidates: z.array(ReferenceCandidate),
});
export type ReferenceScanResult = z.infer<typeof ReferenceScanResult>;
