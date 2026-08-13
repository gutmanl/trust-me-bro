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

/** Channel that derived a candidate's `document_url` (reference auto-
 * import, Task 3b), in the fixed derivation order arXiv PDF > Crossref's
 * own PDF link > Unpaywall — see derive-document-url.ts, the sole writer of
 * this field. */
export const DocumentUrlSource = z.enum(["crossref_pdf", "arxiv", "unpaywall"]);
export type DocumentUrlSource = z.infer<typeof DocumentUrlSource>;

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
  /** Identity cross-check (automatic repair): the candidate's own
   * identifier resolves to a different work than its cited title
   * describes — a hallucinated-identifier signal. Such a candidate is
   * never pre-selected for auto-capture; the note explains the conflict
   * in German and `alternate_title_match` carries what the TITLE resolves
   * to, so the review can offer both hypotheses. */
  identity_conflict: z.boolean().optional(),
  identity_conflict_note: z.string().min(1).optional(),
  alternate_title_match: z
    .strictObject({
      doi: z.string().optional(),
      title: z.string().optional(),
      match_score: z.number().min(0).max(1),
    })
    .optional(),
  suggested_source_type: SourceType,
  /** PDF URL derived for this identifier (reference auto-import, Task 3b):
   * arXiv PDF > Crossref's own `link[]` PDF entry > Unpaywall OA PDF, first
   * hit wins. Absent whenever every step failed or found nothing — never a
   * landing page or a non-PDF link (those would poison the frozen corpus;
   * see document.ts's expectedExt guard). The review UI pre-fills its
   * document-URL field from this; the user may override it. */
  document_url: z.string().optional(),
  /** Which step produced `document_url`, absent iff `document_url` is. */
  document_url_source: DocumentUrlSource.optional(),
});
export type ReferenceCandidate = z.infer<typeof ReferenceCandidate>;

export const ReferenceScanResult = z.strictObject({
  scanned_at: IsoDateTime,
  method: z.enum(["regex", "regex+llm"]),
  candidates: z.array(ReferenceCandidate),
});
export type ReferenceScanResult = z.infer<typeof ReferenceScanResult>;
