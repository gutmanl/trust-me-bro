import { createHash } from "node:crypto";

import type { Source, SourceType } from "../../../register";
import type { ReferenceCandidate } from "./schema";

/**
 * Pure candidate assembly of the reference scan (reference auto-import):
 * minting stable candidate ids, merging the regex/LLM/Crossref channels into
 * one deduplicated candidate list, suggesting a source type per channel, and
 * pre-filtering citations that already have a captured source (spending no
 * Crossref quota on them).
 */

export type CandidateSeedMethod =
  "doi" | "arxiv" | "url" | "crossref_title" | "unresolved";

/** One channel's contribution before merging — the shape regex hits, LLM
 * parsed citations (with or without their own identifier) and Crossref
 * resolutions are all normalized into at the run-reference-scan.ts call
 * site. */
export interface CandidateSeed {
  raw_text: string;
  method: CandidateSeedMethod;
  doi?: string;
  arxiv_id?: string;
  url?: string;
  authors?: string[];
  year?: number;
  title?: string;
  venue?: string;
  match_score?: number;
  crossref_unavailable?: boolean;
}

/**
 * Deterministic candidate id: sha256 of (method, normalized identifier or
 * raw_text when no identifier exists), truncated to a readable length.
 * Depends only on the identity of the resolved work, never on ordering or
 * enrichment — the same citation mints the same id across rescans.
 */
export function candidateId(
  seed: Pick<CandidateSeed, "method" | "doi" | "arxiv_id" | "url" | "raw_text">,
): string {
  const identity = seed.doi ?? seed.arxiv_id ?? seed.url ?? seed.raw_text;
  const canonical = `${seed.method}\n${identity.trim().toLowerCase()}`;
  return `cnd_${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16)}`;
}

/** Suggested source type per the MLR-informed rubric weighting, mirroring
 * the concept chapter's mapping: arXiv → preprint, a resolved DOI (found
 * directly or via Crossref) → peer-reviewed, everything else → grey
 * literature (the safest default — the user confirms/changes it on capture). */
export function suggestSourceType(method: CandidateSeedMethod): SourceType {
  switch (method) {
    case "arxiv":
      return "preprint";
    case "doi":
    case "crossref_title":
      return "peer_reviewed_publication";
    case "url":
    case "unresolved":
      return "grey_literature";
  }
}

function identityKey(seed: CandidateSeed): string | undefined {
  if (seed.doi) {
    return `doi:${seed.doi.trim().toLowerCase()}`;
  }
  if (seed.arxiv_id) {
    return `arxiv:${seed.arxiv_id.trim().toLowerCase()}`;
  }
  if (seed.url) {
    return `url:${seed.url.trim()}`;
  }
  return undefined;
}

function isIdentifiedMethod(method: CandidateSeedMethod): boolean {
  return method === "doi" || method === "arxiv" || method === "url";
}

function seedToCandidate(seed: CandidateSeed): ReferenceCandidate {
  return {
    candidate_id: candidateId(seed),
    raw_text: seed.raw_text,
    method: seed.method,
    ...(seed.doi ? { doi: seed.doi } : {}),
    ...(seed.arxiv_id ? { arxiv_id: seed.arxiv_id } : {}),
    ...(seed.url ? { url: seed.url } : {}),
    ...(seed.authors && seed.authors.length > 0
      ? { authors: seed.authors }
      : {}),
    ...(seed.year !== undefined ? { year: seed.year } : {}),
    ...(seed.title ? { title: seed.title } : {}),
    ...(seed.venue ? { venue: seed.venue } : {}),
    ...(seed.match_score !== undefined
      ? { match_score: seed.match_score }
      : {}),
    ...(seed.crossref_unavailable ? { crossref_unavailable: true } : {}),
    suggested_source_type: suggestSourceType(seed.method),
  };
}

/**
 * Merges the regex, LLM-parsed and Crossref-resolved channels into the
 * final candidate list: two citations that resolve to the same identifier
 * (typically a DOI found by regex AND independently resolved via Crossref
 * for an LLM-parsed prose citation of the same work) collapse into ONE
 * candidate. An identified seed (doi/arxiv/url method) always wins as the
 * merged candidate's method/raw_text over a `crossref_title` seed sharing
 * the same identifier — a directly-found identifier is more authoritative
 * than a fuzzy title match — while richer metadata (title/authors/year/
 * venue) from either side fills in whatever the winner lacks. `match_score`
 * is the one field NOT carried across method boundaries this way (I5 fix):
 * it is a title-similarity confidence, meaningful only when the WINNING
 * method is itself `crossref_title` — copying a `crossref_title` twin's
 * score onto a doi/arxiv/url winner would misrepresent a directly-found
 * identifier as a fuzzy guess. Seeds without any identifier (`unresolved`)
 * never share a merge key and always survive as their own candidate.
 */
export function mergeCandidates(
  seeds: readonly CandidateSeed[],
): ReferenceCandidate[] {
  const merged = new Map<string, CandidateSeed>();
  const unresolved: CandidateSeed[] = [];

  for (const seed of seeds) {
    const key = identityKey(seed);
    if (key === undefined) {
      unresolved.push(seed);
      continue;
    }
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, seed);
      continue;
    }
    const preferSeed =
      !isIdentifiedMethod(existing.method) && isIdentifiedMethod(seed.method);
    const primary = preferSeed ? seed : existing;
    const secondary = preferSeed ? existing : seed;
    merged.set(key, {
      ...primary,
      title: primary.title ?? secondary.title,
      authors: primary.authors ?? secondary.authors,
      year: primary.year ?? secondary.year,
      venue: primary.venue ?? secondary.venue,
      // I5 fix: only a crossref_title WINNER may carry a fuzzy match_score
      // forward. primary.match_score is already undefined for every other
      // method (only crossref_title seeds ever set it — see
      // run-reference-scan.ts), so this only ever suppresses secondary's
      // score from leaking onto a doi/arxiv/url winner.
      match_score:
        primary.method === "crossref_title"
          ? (primary.match_score ?? secondary.match_score)
          : undefined,
    });
  }

  return [...merged.values(), ...unresolved].map(seedToCandidate);
}

/** Identifiers a captured source carries, extracted defensively (loose CSL-
 * JSON item; DOI/URL fields may be absent or of unexpected shape). */
export interface SourceIdentifiers {
  doi?: string;
  arxivId?: string;
  url?: string;
}

const ARXIV_URL_ID_PATTERN = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i;

export function sourceIdentifiers(source: Source): SourceIdentifiers {
  const item = source as unknown as Record<string, unknown>;
  const doi = typeof item.DOI === "string" ? item.DOI.toLowerCase() : undefined;
  const url = typeof item.URL === "string" ? item.URL : undefined;
  const arxivMatch = url ? ARXIV_URL_ID_PATTERN.exec(url) : null;
  return {
    ...(doi ? { doi } : {}),
    ...(arxivMatch ? { arxivId: arxivMatch[1] } : {}),
    ...(url ? { url } : {}),
  };
}

/** True when a candidate-shaped item's own identifier equals one of a
 * source's identifiers (doi/arxiv/url compared per its own kind). */
export function identifierMatches(
  item: { doi?: string; arxiv_id?: string; url?: string },
  identifiers: SourceIdentifiers,
): boolean {
  if (
    item.doi &&
    identifiers.doi &&
    item.doi.toLowerCase() === identifiers.doi
  ) {
    return true;
  }
  if (
    item.arxiv_id &&
    identifiers.arxivId &&
    item.arxiv_id === identifiers.arxivId
  ) {
    return true;
  }
  if (item.url && identifiers.url && item.url === identifiers.url) {
    return true;
  }
  return false;
}

/**
 * Pre-filters citations that already have a captured source BEFORE any
 * Crossref lookup — an identifier match (doi/arxiv/url equality) catches a
 * regex/LLM-identified citation of an already-captured work; a raw_text
 * match against a source's `auto_capture` provenance additionally catches an
 * identifier-less citation an EARLIER scan+capture cycle already resolved
 * (so a rescan does not re-spend Crossref quota resolving it again).
 */
export function excludeCaptured<
  T extends { raw_text: string; doi?: string; arxiv_id?: string; url?: string },
>(items: readonly T[], sources: readonly Source[]): T[] {
  const identifiers = sources.map(sourceIdentifiers);
  return items.filter((item) => {
    if (identifiers.some((ids) => identifierMatches(item, ids))) {
      return false;
    }
    return !sources.some(
      (source) => source.custom.auto_capture?.raw_text === item.raw_text,
    );
  });
}
