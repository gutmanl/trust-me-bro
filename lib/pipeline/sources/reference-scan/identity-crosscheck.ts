import type { HttpFetcher } from "../fetch-port";
import { firstAuthorFamily, issuedYear } from "../csl";
import { resolveArxiv, resolveDoi } from "../resolve";
import type { CandidateSeed } from "./candidate";
import { MATCH_FLOOR, scoreMatch } from "./crossref-match";
import { matchViaCrossrefTitle } from "./title-resolution";

/** Below this score the resolved identifier's metadata and the citation's
 * own title/authors/year are considered to describe DIFFERENT works. Reuses
 * the scan's established floor: anything the fuzzy matcher would not even
 * attach as a guess cannot count as agreement either. */
export const IDENTITY_CONFLICT_THRESHOLD = MATCH_FLOOR;

/**
 * Preventive identity cross-check of an identified candidate seed
 * (automatic repair): an LLM-supplied — possibly hallucinated — DOI/arXiv
 * id resolves to REAL metadata, which is scored against the citation's own
 * parsed title/authors/year. Agreement (or no title to compare against, or
 * any resolution/network failure — fail open, a remote hiccup must never
 * change scan behavior) returns the seed unchanged. A conflict marks the
 * seed so the review withholds it from auto-capture, and a second Crossref
 * title lookup attaches the competing hypothesis ("the title points at
 * this OTHER work") for the human to choose from.
 */
export async function crossCheckIdentifiedSeed(
  seed: CandidateSeed,
  fetcher: HttpFetcher,
  sleep?: (ms: number) => Promise<void>,
): Promise<CandidateSeed> {
  const identifier = seed.method === "doi" ? seed.doi : seed.arxiv_id;
  if (
    (seed.method !== "doi" && seed.method !== "arxiv") ||
    !identifier ||
    !seed.title
  ) {
    return seed;
  }

  let resolvedItem: Record<string, unknown>;
  try {
    const { item } =
      seed.method === "doi"
        ? await resolveDoi(identifier, fetcher)
        : await resolveArxiv(identifier, fetcher);
    resolvedItem = item;
  } catch {
    // Resolution failed (dead identifier, network) — the capture attempt
    // itself will surface that failure; the cross-check stays silent.
    return seed;
  }

  const resolvedTitle =
    typeof resolvedItem.title === "string" ? resolvedItem.title : "";
  const family = firstAuthorFamily(resolvedItem);
  const score = scoreMatch(
    { title: seed.title, year: seed.year, authors: seed.authors ?? [] },
    {
      title: resolvedTitle,
      year: issuedYear(resolvedItem),
      authors: family ? [family] : [],
    },
  );
  if (score >= IDENTITY_CONFLICT_THRESHOLD) {
    return seed;
  }

  // Conflict: identifier and citation title point at different works. Ask
  // Crossref which work the TITLE describes, as the competing hypothesis.
  const alternate = await matchViaCrossrefTitle(
    { title: seed.title, authors: seed.authors ?? [], year: seed.year },
    fetcher,
    sleep,
  );
  const alternateIsDifferent =
    alternate.doi !== undefined &&
    alternate.doi.toLowerCase() !== (seed.doi ?? "").toLowerCase();
  return {
    ...seed,
    identity_conflict: true,
    identity_conflict_note:
      "Die Kennung löst zu einem anderen Werk auf als der zitierte Titel " +
      `(Übereinstimmung ${Math.round(score * 100)} %: „${resolvedTitle}") – ` +
      "mögliche halluzinierte Kennung, bitte prüfen.",
    ...(alternateIsDifferent
      ? {
          alternate_title_match: {
            ...(alternate.doi ? { doi: alternate.doi } : {}),
            ...(alternate.title ? { title: alternate.title } : {}),
            match_score: alternate.match_score ?? 0,
          },
        }
      : {}),
  };
}
