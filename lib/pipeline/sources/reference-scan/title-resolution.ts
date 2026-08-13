import type { HttpFetcher } from "../fetch-port";
import type { CrossrefWork } from "./crossref";
import { searchCrossref } from "./crossref";
import { MATCH_FLOOR, scoreMatch } from "./crossref-match";
import { cleanReferenceTitle } from "./reference-title";

/** What a Crossref title lookup yields for a citation without (or with a
 * suspect) identifier of its own. */
export interface TitleMatch {
  doi?: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  match_score?: number;
  crossref_unavailable?: boolean;
}

/** The citation-side inputs the lookup scores against. */
export interface TitleMatchReference {
  title?: string;
  authors: readonly string[];
  year?: number;
}

/**
 * Resolves one citation via Crossref title/author/year similarity — shared
 * by the reference scan (identifier-less citations) and the automatic
 * repair (re-deriving an identity a hallucinated identifier obscured).
 * Crossref not being reachable/answerable at all (network error, non-200,
 * exhausted 429 retry — see crossref.ts's `unavailable` flag) marks the
 * result `crossref_unavailable`; a normal response with zero or no
 * confident-enough results (below MATCH_FLOOR) returns empty without that
 * flag (Crossref answered, just found nothing — I3 fix: these two cases
 * used to be conflated because both produced an empty `works` array).
 */
export async function matchViaCrossrefTitle(
  reference: TitleMatchReference,
  fetcher: HttpFetcher,
  sleep?: (ms: number) => Promise<void>,
): Promise<TitleMatch> {
  // Clean the title (strip a "| venue" suffix, ellipsis truncation, quotes)
  // before it hits Crossref: it is both the query and the string the bigram
  // similarity scores against Crossref's own clean title.
  const cleanTitle = cleanReferenceTitle(reference.title ?? "");
  const query = [cleanTitle, reference.authors.join(" ")]
    .filter((part) => part.trim().length > 0)
    .join(" ");
  const { works, unavailable } = await searchCrossref(
    query,
    fetcher,
    sleep ? { sleep } : {},
  );
  if (unavailable) {
    return { crossref_unavailable: true };
  }

  let best: { work: CrossrefWork; score: number } | undefined;
  for (const work of works) {
    const score = scoreMatch(
      {
        title: cleanTitle,
        year: reference.year,
        authors: [...reference.authors],
      },
      work,
    );
    if (!best || score > best.score) {
      best = { work, score };
    }
  }
  if (!best || best.score < MATCH_FLOOR || !best.work.doi) {
    return {};
  }
  return {
    doi: best.work.doi,
    title: best.work.title,
    authors: best.work.authors,
    year: best.work.year,
    venue: best.work.venue,
    match_score: best.score,
  };
}
