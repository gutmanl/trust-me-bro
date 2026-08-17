import type { Source } from "../../register";
import { formatCitationItem } from "./csl";

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
  /** When the source was originally captured (ISO 8601) — revision 1's
   * snapshot, not the current one. */
  capturedAt: string;
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
 * (`previous_snapshots[].retrieved_at`, `auto_capture.*`) or read through a
 * shape guard: `previous_identities[].item` is a bare
 * `z.record(z.string(), z.unknown())`, so `formatCitationItem` and the
 * `fallbackLabel` derivation must treat its contents as hostile. Adding a read
 * of unvalidated register data here means adding its guard in the same change.
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
  // every identity correction revises the snapshot before archiving the
  // identity, so on a corrected source `custom.snapshot.retrieved_at` is the
  // correction date. `previous_snapshots` is append-only in revision order and
  // revisions start at 1, so [0] — and only [0] — is the original capture.
  //
  // No fallback to `custom.snapshot`: that value is the correction's date, and
  // the app renders this field under the label "Erfasst am", so falling back
  // would assert the one thing this projection exists to disprove. The state is
  // reachable — `tx.correctSourceIdentity` and `tx.reviseSource` are
  // independent transaction capabilities, and a hand-edited or
  // foreign-authored .tmb bundle satisfies the schema with an archived identity
  // and no archived snapshot — so it fails closed, like the no-snapshot-at-all
  // case always has: with no original date to state, there is nothing to state.
  const originalSnapshot = source.custom.previous_snapshots?.[0];
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
  const archivedId = first.item.id;
  const fallbackLabel =
    typeof archivedId === "string" && archivedId.length > 0
      ? archivedId
      : source.id;

  return {
    citation: formatCitationItem(first.item, fallbackLabel),
    capturedAt: originalSnapshot.retrieved_at,
    ...(auto !== undefined
      ? { autoCapture: { method: auto.method, rawText: auto.raw_text } }
      : {}),
  };
}
