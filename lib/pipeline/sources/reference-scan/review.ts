import type { Source } from "../../../register";
import { identifierMatches, sourceIdentifiers } from "./candidate";
import { CONFIDENT_THRESHOLD } from "./crossref-match";
import type { ReferenceCandidate, ReferenceScanResult } from "./schema";

/**
 * Pure review projection of a reference scan (reference auto-import): re-
 * derives "already captured" at READ time against the CURRENT source list
 * (not just what excludeCaptured saw when the scan ran — a source captured
 * AFTER the scan, e.g. manually, still shows up as already captured on the
 * next page load) and computes the two UI-facing defaults, `capturable` and
 * `selected`.
 */

export interface ReviewCandidate extends ReferenceCandidate {
  alreadyCaptured: boolean;
  /** Id of the source this candidate was already captured as, when
   * alreadyCaptured. */
  capturedAsSourceId?: string;
  /** False for `unresolved` candidates, and for `url`-method candidates
   * with no title (nothing to caption the capture with). */
  capturable: boolean;
  /** Default checkbox state: capturable, and — for a fuzzy Crossref title
   * match — only pre-checked once it clears the confidence threshold. */
  selected: boolean;
}

export function buildCandidateReview(
  scanResult: ReferenceScanResult,
  sources: readonly Source[],
): ReviewCandidate[] {
  const bySource = sources.map((source) => ({
    source,
    identifiers: sourceIdentifiers(source),
  }));

  return scanResult.candidates.map((candidate) => {
    const captured = bySource.find(
      ({ source, identifiers }) =>
        identifierMatches(candidate, identifiers) ||
        (source.custom.auto_capture?.raw_text === candidate.raw_text &&
          source.custom.auto_capture?.method === candidate.method),
    );
    const alreadyCaptured = captured !== undefined;
    const capturable =
      candidate.method !== "unresolved" &&
      (candidate.method !== "url" || Boolean(candidate.title));
    const selected =
      capturable &&
      // A candidate whose identifier and cited title point at different
      // works (identity cross-check) is never pre-checked: the human
      // chooses between the two hypotheses instead of auto-capturing a
      // possibly hallucinated identifier.
      candidate.identity_conflict !== true &&
      (candidate.method !== "crossref_title" ||
        (candidate.match_score ?? 0) >= CONFIDENT_THRESHOLD);

    return {
      ...candidate,
      alreadyCaptured,
      ...(captured ? { capturedAsSourceId: captured.source.id } : {}),
      capturable,
      selected,
    };
  });
}
