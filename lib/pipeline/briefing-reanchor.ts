import { containsNormalized } from "../register";
import type { Claim } from "../register";

/**
 * Silent re-anchor pass run inside a briefing revision's transaction
 * (briefing-revision.ts): for every claim carrying an `anchor_quote`,
 * resolves where that verbatim quote now lives in the revised paragraph
 * split and, if that differs from the claim's stored `briefing_anchor`,
 * emits a mechanical update. Pure and filesystem-free like the projection's
 * `resolveClaimAnchor` in `lib/register/projection/briefing-view.ts`, which
 * this mirrors but for a narrower purpose: that function resolves a
 * DISPLAY position for every claim (falling back to a drifted hint or
 * unanchored); this one decides only whether a REGISTER WRITE is needed, and
 * stays silent (emits nothing) when the quote cannot be found at all — the
 * claim keeps its stale anchor, and the view model already surfaces that
 * drift to the user.
 */

export interface ReanchorUpdate {
  claimId: string;
  anchor: string;
  quote: string;
}

function hintIndex(anchor: string, paragraphCount: number): number | null {
  const match = /^p([1-9][0-9]*)$/.exec(anchor);
  if (!match) {
    return null;
  }
  const index = Number(match[1]) - 1;
  return index < paragraphCount ? index : null;
}

/**
 * Resolution order per claim, hint-first then full-scan:
 * 1. The current `briefing_anchor`'s `p<N>` hint, if it parses, is in range
 *    of the new paragraphs, and that paragraph still contains the quote.
 * 2. Otherwise the first paragraph (in order) that contains the quote.
 * 3. Otherwise nothing is emitted — the quote is gone from the revised text
 *    entirely, and a stale anchor is preferable to a guess.
 * An update is emitted only when the resolved position differs from the
 * claim's current `briefing_anchor` — an unmoved quote produces no update
 * (and therefore no register write for that claim). Claims without
 * `anchor_quote` (legacy, position-only) are skipped entirely.
 */
export function computeReanchorUpdates(
  newParagraphs: string[],
  claims: readonly Pick<Claim, "id" | "briefing_anchor" | "anchor_quote">[],
): ReanchorUpdate[] {
  const updates: ReanchorUpdate[] = [];
  for (const claim of claims) {
    const quote = claim.anchor_quote;
    if (quote === undefined) {
      continue;
    }
    const hint = hintIndex(claim.briefing_anchor, newParagraphs.length);
    let foundIndex: number | null = null;
    if (hint !== null && containsNormalized(newParagraphs[hint], quote)) {
      foundIndex = hint;
    } else {
      const scanIndex = newParagraphs.findIndex((text) =>
        containsNormalized(text, quote),
      );
      foundIndex = scanIndex === -1 ? null : scanIndex;
    }
    if (foundIndex === null) {
      continue;
    }
    const newAnchor = `p${foundIndex + 1}`;
    if (newAnchor !== claim.briefing_anchor) {
      updates.push({ claimId: claim.id, anchor: newAnchor, quote });
    }
  }
  return updates;
}
