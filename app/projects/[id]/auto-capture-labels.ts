/**
 * German display tier for a source's auto-import provenance.
 *
 * Lifted out of `page.tsx` (where the map used to sit inline) for one reason:
 * the map alone is not enough to say how a source was captured. Turning a
 * `method` enum value into a sentence needs a decision that `page.tsx` had
 * made with a ternary and got wrong for one value — so the decision lives here,
 * next to the wording it depends on, where a test can reach it.
 */

/** The schema's `AutoCaptureProvenance.method` values. */
export type AutoCaptureMethod =
  "doi" | "arxiv" | "url" | "crossref_title" | "unresolved";

/**
 * German label per auto-import method, for the provenance note next to an
 * automatically captured source. A fuzzy `crossref_title` match resolved a
 * REAL DOI, but the identifier was GUESSED by title similarity rather than
 * found verbatim in the text — that difference has to stay legible.
 */
export const AUTO_CAPTURE_METHOD_LABELS: Record<AutoCaptureMethod, string> = {
  doi: "DOI im Text gefunden",
  arxiv: "arXiv-Id im Text gefunden",
  url: "URL im Text gefunden",
  crossref_title: "Titelabgleich",
  unresolved: "textuell gefunden, manuell vervollständigt",
};

/**
 * How the source was ORIGINALLY captured, as a clause that stands on its own
 * after "Erfasst am <Datum> – ". `undefined` means the source never went
 * through the reference auto-import flow at all.
 *
 * Deliberately not a two-way binary. `unresolved` means the scan found the
 * citation textually but could pin NO identifier, and the user completed the
 * capture by hand — uploading a PDF or giving a URL (see the schema comment on
 * `AutoCaptureProvenance.method`). Wrapping that in "automatisch übernommen"
 * yields the self-contradicting "automatisch übernommen (textuell gefunden,
 * manuell vervollständigt)" and files a hand-completed source under
 * "automatic". Its own label already says what happened, so it is stated
 * alone — no call site has to assert a provenance the enum value does not
 * support.
 */
export function originalCaptureProvenanceLabel(
  method: AutoCaptureMethod | undefined,
): string {
  if (method === undefined) {
    return "manuell erfasst";
  }
  if (method === "unresolved") {
    return AUTO_CAPTURE_METHOD_LABELS.unresolved;
  }
  return `automatisch übernommen (${AUTO_CAPTURE_METHOD_LABELS[method]})`;
}
