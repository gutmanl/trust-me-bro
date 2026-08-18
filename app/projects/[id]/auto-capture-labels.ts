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

/**
 * The row-level auto-import note, or `undefined` when the row must not carry
 * one. Relocated out of `page.tsx` verbatim — not one byte of German is
 * changed here; what changed is WHERE the note renders.
 *
 * Suppressed on a corrected source, and that is the whole of the fix (WR-04).
 * `auto_capture` describes the ORIGINAL capture, and on a corrected source the
 * original-identity block above the note already states that capture's
 * provenance — accurately, through the three-case
 * `originalCaptureProvenanceLabel`. Leaving the note there made the row assert
 * the superseded provenance a second time, and for `unresolved` the two
 * statements contradicted each other one line apart: the block said the
 * capture was completed by hand, the note's two-way ternary filed it under
 * "automatisch übernommen".
 *
 * Deliberate consequence: on a corrected fuzzy match the percentage warning
 * disappears with the note. That is correct — the warning describes how good a
 * GUESS at the identity was, and after a manual correction the user has
 * already replaced that guess, so the number no longer says anything about the
 * identity the row now shows.
 *
 * `originalIdentityShown` must be the value the block itself was built from,
 * never a re-derived predicate: `deriveOriginalIdentity` also returns
 * `undefined` when the archived snapshot is missing, so an independently
 * derived "has previous identities" test would disagree with the block on
 * exactly that state.
 */
export function autoCaptureRowNote(
  auto: { method: AutoCaptureMethod; score?: number } | undefined,
  { originalIdentityShown }: { originalIdentityShown: boolean },
): string | undefined {
  if (auto === undefined || originalIdentityShown) {
    return undefined;
  }
  return auto.method === "crossref_title"
    ? `⚠ automatisch übernommen – ${AUTO_CAPTURE_METHOD_LABELS.crossref_title} (${Math.round((auto.score ?? 0) * 100)}% Übereinstimmung)`
    : `automatisch übernommen – ${AUTO_CAPTURE_METHOD_LABELS[auto.method]}`;
}
