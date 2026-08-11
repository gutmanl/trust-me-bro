import type { Claim } from "../schema/claim";
import type { ClaimsRegister } from "../schema/register";
import { containsNormalized, splitBriefingParagraphs } from "../text/normalize";

/**
 * Structured briefing view model shared by the markdown projection
 * (render-briefing.ts) and the interactive review UI (TMB-33). Anchor
 * resolution, deterministic claim ordering and the global evidence numbering
 * live ONLY here — two independent implementations could silently diverge on
 * edge cases (anchors beyond the paragraph count, tie-breaking by id).
 *
 * Pure and filesystem-free like every projection; all orderings derive from
 * stable keys (anchor position, then claim id), never from array order.
 *
 * Anchor convention: `briefing_anchor` values of the form p<N> refer to the
 * N-th paragraph (1-based) of the briefing original, where paragraphs are
 * separated by blank lines. Claims with anchors that do not resolve are
 * collected in `unanchored` instead of being dropped.
 */

export const CONFIRMED_STATUSES: ReadonlySet<Claim["status"]> = new Set([
  "confirmed",
  "auto_confirmed",
]);

export interface ClaimMarkerVM {
  claim: Claim;
  /** Global 1-based numbers of this claim's evidence, in evidence order. */
  evidenceNumbers: number[];
  /** True when the claim's resolved position disagrees with (or replaces) its
   * `briefing_anchor` hint: an `anchor_quote` claim whose quote moved to a
   * different paragraph, was found only via the hint fallback, or is
   * unresolvable altogether. Always false for legacy claims (no
   * `anchor_quote`), which keep the pre-existing position-only behaviour. */
  anchorDrifted: boolean;
}

export interface BriefingParagraphVM {
  /** 0-based paragraph index. */
  index: number;
  text: string;
  /** Claims anchored to this paragraph, in deterministic order. */
  claims: ClaimMarkerVM[];
}

export interface BriefingViewModel {
  paragraphs: BriefingParagraphVM[];
  /** Claims whose anchor did not resolve to a paragraph. */
  unanchored: ClaimMarkerVM[];
  /** All claims in the deterministic order (anchor position, then id) the
   * evidence numbering follows — the iteration order of the Belege list. */
  orderedClaims: ClaimMarkerVM[];
  /** `${claimId}/${evidenceId}` → global 1-based evidence number. A plain
   * object, not a Map: the view model crosses the RSC serialization
   * boundary. */
  evidenceNumbers: Record<string, number>;
  /** Claims currently awaiting adjudication. */
  openCount: number;
  /** Claims not (yet) confirmed, including discarded ones. */
  unconfirmedCount: number;
  /** Banner condition (TMB-33): no claim awaits adjudication. Named
   * `isFullyAdjudicated` rather than `isVerified` to avoid falsely
   * suggesting the verification stage — the computed condition is "no claim
   * pending adjudication". */
  isFullyAdjudicated: boolean;
}

interface AnchoredClaim {
  claim: Claim;
  paragraphIndex: number | null;
  anchorDrifted: boolean;
}

function anchorParagraphIndex(
  claim: Claim,
  paragraphCount: number,
): number | null {
  const match = /^p([1-9][0-9]*)$/.exec(claim.briefing_anchor);
  if (!match) {
    return null;
  }
  const index = Number(match[1]) - 1;
  return index < paragraphCount ? index : null;
}

interface AnchorResolution {
  paragraphIndex: number | null;
  anchorDrifted: boolean;
}

/**
 * Quote-first anchor resolution (workbench epic): a claim carrying
 * `anchor_quote` is resolved by that verbatim quote, not by paragraph
 * position alone — the display truth wins over a stale `briefing_anchor`.
 * Resolution order:
 * 1. The legacy `p<N>` hint, if it parses and is in range.
 * 2. If `anchor_quote` is set and the hint's paragraph still contains it →
 *    resolved at the hint, `anchorDrifted: false`.
 * 3. Else scan every paragraph for the first containing the quote →
 *    resolved there (position may have moved, but the quote itself is
 *    intact), `anchorDrifted: false`.
 * 4. Else fall back to the hint if it was valid, `anchorDrifted: true`; if
 *    the hint was also invalid, unanchored, `anchorDrifted: true`.
 * A claim without `anchor_quote` (legacy) keeps the pre-existing
 * position-only behaviour, `anchorDrifted: false`.
 */
function resolveClaimAnchor(
  claim: Claim,
  paragraphTexts: string[],
): AnchorResolution {
  const hint = anchorParagraphIndex(claim, paragraphTexts.length);
  const quote = claim.anchor_quote;
  if (quote === undefined) {
    return { paragraphIndex: hint, anchorDrifted: false };
  }
  if (hint !== null && containsNormalized(paragraphTexts[hint], quote)) {
    return { paragraphIndex: hint, anchorDrifted: false };
  }
  const scanIndex = paragraphTexts.findIndex((text) =>
    containsNormalized(text, quote),
  );
  if (scanIndex !== -1) {
    return { paragraphIndex: scanIndex, anchorDrifted: false };
  }
  if (hint !== null) {
    return { paragraphIndex: hint, anchorDrifted: true };
  }
  return { paragraphIndex: null, anchorDrifted: true };
}

function compareClaims(a: AnchoredClaim, b: AnchoredClaim): number {
  const pa = a.paragraphIndex ?? Number.MAX_SAFE_INTEGER;
  const pb = b.paragraphIndex ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) {
    return pa - pb;
  }
  return a.claim.id < b.claim.id ? -1 : a.claim.id > b.claim.id ? 1 : 0;
}

export function buildBriefingViewModel(
  briefingOriginal: string,
  register: ClaimsRegister,
): BriefingViewModel {
  const paragraphTexts = splitBriefingParagraphs(briefingOriginal);

  const anchored: AnchoredClaim[] = register.claims
    .map((claim) => {
      const { paragraphIndex, anchorDrifted } = resolveClaimAnchor(
        claim,
        paragraphTexts,
      );
      return { claim, paragraphIndex, anchorDrifted };
    })
    .sort(compareClaims);

  // Global inline evidence numbering in deterministic claim order.
  const evidenceNumbers: Record<string, number> = {};
  let nextNumber = 1;
  for (const { claim } of anchored) {
    for (const evidence of claim.evidence) {
      evidenceNumbers[`${claim.id}/${evidence.id}`] = nextNumber;
      nextNumber += 1;
    }
  }

  const toMarker = ({
    claim,
    anchorDrifted,
  }: AnchoredClaim): ClaimMarkerVM => ({
    claim,
    evidenceNumbers: claim.evidence.map(
      (evidence) => evidenceNumbers[`${claim.id}/${evidence.id}`],
    ),
    anchorDrifted,
  });

  const paragraphs: BriefingParagraphVM[] = paragraphTexts.map(
    (text, index) => ({
      index,
      text,
      claims: anchored
        .filter((entry) => entry.paragraphIndex === index)
        .map(toMarker),
    }),
  );
  const unanchored = anchored
    .filter((entry) => entry.paragraphIndex === null)
    .map(toMarker);

  const openCount = register.claims.filter(
    (claim) => claim.status === "pending_adjudication",
  ).length;
  const unconfirmedCount = register.claims.filter(
    (claim) => !CONFIRMED_STATUSES.has(claim.status),
  ).length;

  return {
    paragraphs,
    unanchored,
    orderedClaims: anchored.map(toMarker),
    evidenceNumbers,
    openCount,
    unconfirmedCount,
    isFullyAdjudicated: openCount === 0,
  };
}
