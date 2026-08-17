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
  // revisions start at 1, so [0] is the original capture; the fallback is
  // defensive only, since a corrected source has always archived a snapshot.
  const originalSnapshot =
    source.custom.previous_snapshots?.[0] ?? source.custom.snapshot;
  if (!originalSnapshot) {
    return undefined;
  }

  // `auto_capture` describes the original entry and is carried through every
  // correction untouched, so its presence — not the current identity — decides
  // whether the original was auto-imported or entered by hand.
  const auto = source.custom.auto_capture;

  return {
    citation: formatCitationItem(
      first.item,
      String(first.item.id ?? source.id),
    ),
    capturedAt: originalSnapshot.retrieved_at,
    ...(auto !== undefined
      ? { autoCapture: { method: auto.method, rawText: auto.raw_text } }
      : {}),
  };
}
