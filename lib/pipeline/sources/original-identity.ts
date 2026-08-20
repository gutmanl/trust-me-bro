import type { Source } from "../../register";
import { firstAuthorFamily, formatCitationItem } from "./csl";

/**
 * The very first identity a corrected source ever carried, projected for the
 * sources rail. Without it the row shows the corrected identity only, so after
 * a correction nothing on screen says what the source originally claimed to be
 * — the recognition this display exists for. Pure derivation over the register:
 * nothing here is persisted, so it can never disagree with the history it reads.
 */
export interface OriginalIdentityVM {
  /** Citation label of `previous_identities[0].item`, formatted through the
   * same code path as the current identity so both read identically. */
  citation: string;
  /** When the source was originally captured (ISO 8601) — always revision 1's
   * snapshot, which is the CURRENT snapshot only when no correction and no
   * revision ever rotated the document. */
  capturedAt: string;
  /** The archived item's own title. Present only when the citation does not
   * already carry it — an item without a usable author family is cited BY its
   * title, so a separate line would print the same string twice. */
  title?: string;
  /** Present iff the source entered through the reference auto-import flow.
   * `method` stays the English enum value: this layer is label-free, the
   * German wording is mapped in the app tier. */
  autoCapture?: {
    method: "doi" | "arxiv" | "url" | "crossref_title" | "unresolved";
    rawText: string;
  };
}

/**
 * Projects the source's first archived identity, or `undefined` when there is
 * none to show. Never throws — like every other `derive*` in this layer,
 * missing data means "nothing to display", never a failure.
 *
 * That guarantee is load-bearing rather than decorative: this runs inside the
 * project page's server render, so a throw here fails the render of
 * `/projects/[id]` — the only place from which a source can be corrected — and
 * the register is append-only, so the offending row could not be deleted.
 * It holds because every value read below is either schema-validated
 * (`previous_snapshots[].retrieved_at`, `snapshot.retrieved_at`,
 * `auto_capture.*`) or read through a
 * shape guard: `previous_identities[].item` is a bare
 * `z.record(z.string(), z.unknown())`, so `formatCitationItem` and the
 * `fallbackLabel` derivation must treat its contents as hostile. `item.title`
 * is the second such read and carries its own guard for the same reason.
 * Adding a read of unvalidated register data here means adding its guard in
 * the same change.
 */
export function deriveOriginalIdentity(
  source: Source,
): OriginalIdentityVM | undefined {
  const first = source.custom.previous_identities?.[0];
  // Index [0] and nothing else: the array is append-only in correction order,
  // so [0] is the very first identity even after several corrections. No
  // corrections at all means the row must render exactly as it did before this
  // projection existed.
  if (!first) {
    return undefined;
  }

  // The original capture date is revision 1's snapshot, NOT the current one:
  // an identity correction that ROTATES the document revises the snapshot
  // before archiving the identity, so on such a source
  // `custom.snapshot.retrieved_at` is the correction date.
  // `previous_snapshots` is append-only in revision order and revisions start
  // at 1, so [0] — and only [0] — is the original capture.
  //
  // With nothing archived, `custom.snapshot` may stand in ONLY while it is
  // still revision 1. Revision 1 means no correction and no revision ever
  // rotated the document, so that snapshot IS the original capture and its
  // `retrieved_at` is honest under the app's "Erfasst am" label. That is the
  // metadata-only correction of the three-way correction modal: it archives an
  // identity and deliberately leaves the document alone, and without this the
  // "Ursprünglich erfasst als:" block would silently vanish for exactly the
  // sources this projection exists for.
  //
  // NARROWED, never removed: for revision > 1 the refusal stays exactly as it
  // was written. That value is then the date of whichever revision rotated the
  // document, and falling back to it would assert the one thing this
  // projection exists to disprove. The state is reachable —
  // `tx.correctSourceIdentity` and `tx.reviseSource` are independent
  // transaction capabilities, and a hand-edited or foreign-authored .tmb
  // bundle satisfies the schema with an archived identity and a rotated
  // snapshot — so it fails closed, like the no-snapshot-at-all case always
  // has: with no original date to state, there is nothing to state.
  const currentSnapshot = source.custom.snapshot;
  const originalSnapshot =
    source.custom.previous_snapshots?.[0] ??
    (currentSnapshot?.revision === 1 ? currentSnapshot : undefined);
  if (!originalSnapshot) {
    return undefined;
  }

  // `auto_capture` describes the original entry and is carried through every
  // correction untouched, so its presence — not the current identity — decides
  // whether the original was auto-imported or entered by hand.
  const auto = source.custom.auto_capture;

  // The fallback label only earns its place if it is always renderable, and
  // `item.id` is schema-unvalidated `unknown`: `??` lets an empty string
  // through (the row would print "Ursprünglich erfasst als:" and nothing) and
  // `String()` would render a non-string as "[object Object]". Anything that is
  // not a usable string falls through to the source's own `SourceId`, which the
  // schema guarantees non-empty — the same value formatCitation passes.
  //
  // TRIMMED non-empty, this path's single definition of "usable string" — the
  // same test `formatCitationItem`'s title head applies, and the one the
  // comment above that head cites as parity. Raw length was not that test: a
  // whitespace-only archived id passed it and became the fallback LABEL, so the
  // row printed the German label followed by nothing, or ", ICSE" with a comma
  // and whitespace in front of it (G-01-4). The `typeof` narrowing stays FIRST
  // — `.trim()` on a non-string throws inside this server render — and the
  // value assigned is `archivedId` itself, never the trimmed one.
  //
  // Reachable only from a hand-edited or foreign `.tmb` bundle: in-app the
  // archived item is `toPlainCsl(existing)` carrying a regex-validated
  // `SourceId`. That is the hostile-input threat model this module's JSDoc
  // names, which is why the guard is repaired rather than dismissed.
  const archivedId = first.item.id;
  const fallbackLabel =
    typeof archivedId === "string" && archivedId.trim().length > 0
      ? archivedId
      : source.id;

  // The citation names the original by author and YEAR, so where a correction
  // shares author and venue with the original — the live case this projection
  // failed on — the year is the only thing telling them apart, which is not
  // how anyone recognizes a paper. The title is what does (G-01-2).
  //
  // Two guards, both load-bearing:
  //
  // 1. Shape. `item.title` is schema-unvalidated `unknown` (the item is a bare
  //    `z.record(z.string(), z.unknown())`, stored verbatim from a third-party
  //    resolver for a DOI-resolved source), and a CSL title is legally an ARRAY
  //    in some producers. Only a non-empty string may be trusted; anything else
  //    degrades to no title. Never coerce and never `String()` it: this runs in
  //    the server render of `/projects/[id]`, the only page from which a source
  //    can be corrected, over an append-only register — a throw bricks the row
  //    permanently and a stringified object renders "[object Object]".
  // 2. Double print. `formatCitationItem` uses the title AS the citation head
  //    when it finds no author family, so emitting the line unconditionally
  //    would print the same string twice. The condition therefore reads
  //    `firstAuthorFamily` — the very function that branch reads — rather than
  //    a re-derived "does the item have an author" check, which would drift
  //    from it: an `author: [null]`, an `author: ["Mayer, A."]` and an
  //    `author: [{ literal: "   " }]` array are each truthy and present yet
  //    yield no family, so a hand-rolled predicate would double-print.
  //
  //    Sharing the FUNCTION is necessary but not sufficient, and assuming it
  //    was sufficient is exactly what let G-01-3 through: the two sites must
  //    also apply the same PREDICATE to its result. This one used to ask
  //    `!== undefined` while the head branch asked for truthiness, and for a
  //    whitespace-only literal author `firstAuthorFamily` returned the empty
  //    string — defined, so the title was emitted as its own line; falsy, so
  //    the head branch had already made that same title the citation. The test
  //    below is now the one the head branch asks. After the trimmed-literal
  //    guard in csl.ts the empty string can no longer be returned at all, so
  //    this is belt and braces: the suppression stays correct even if
  //    `firstAuthorFamily` ever regresses, because it no longer asks a strictly
  //    weaker question than the branch it mirrors.
  //
  // The two halves of the expression below ask DIFFERENT questions on purpose.
  //
  //  * The TITLE half applies this path's single definition of "usable string"
  //    — type `string` with `.trim().length > 0` — because that is the very
  //    question `formatCitationItem`'s title head asks. Testing raw length here
  //    made the two disagree on `title: "   "`: the head called it unusable and
  //    cited the author, this half called it usable and emitted it, so the
  //    block rendered a blank paragraph between two real lines (G-01-4).
  //  * The FAMILY half stays a RAW non-empty test, and is the single deliberate
  //    exception to that definition. It mirrors the head branch's TRUTHINESS
  //    test (`family ? … : …`), not a usability test. If `firstAuthorFamily`
  //    ever regressed to returning a whitespace-only family, the head branch
  //    would consume it as the citation head while a trimmed test here would
  //    discard the title — losing the title entirely instead of printing it
  //    twice. Mirroring the weaker test is what keeps this fail-safe.
  const archivedFamily = firstAuthorFamily(first.item);
  const archivedTitle = first.item.title;
  const title =
    typeof archivedTitle === "string" &&
    archivedTitle.trim().length > 0 &&
    archivedFamily !== undefined &&
    archivedFamily.length > 0
      ? archivedTitle
      : undefined;

  return {
    citation: formatCitationItem(first.item, fallbackLabel),
    capturedAt: originalSnapshot.retrieved_at,
    ...(title !== undefined ? { title } : {}),
    ...(auto !== undefined
      ? { autoCapture: { method: auto.method, rawText: auto.raw_text } }
      : {}),
  };
}
