import type { Claim } from "../schema/claim";
import type { ClaimsRegister } from "../schema/register";

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
  "bestaetigt",
  "automatisch_bestaetigt",
]);

export interface ClaimMarkerVM {
  claim: Claim;
  /** Global 1-based numbers of this claim's evidence, in evidence order. */
  evidenceNumbers: number[];
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
  /** Banner condition (TMB-33): no claim awaits adjudication. */
  isGeprueft: boolean;
}

interface AnchoredClaim {
  claim: Claim;
  paragraphIndex: number | null;
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
  const normalized = briefingOriginal.replace(/\r\n?/g, "\n").trim();
  const paragraphTexts = normalized.length > 0 ? normalized.split(/\n{2,}/) : [];

  const anchored: AnchoredClaim[] = register.claims
    .map((claim) => ({
      claim,
      paragraphIndex: anchorParagraphIndex(claim, paragraphTexts.length),
    }))
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

  const toMarker = ({ claim }: AnchoredClaim): ClaimMarkerVM => ({
    claim,
    evidenceNumbers: claim.evidence.map(
      (evidence) => evidenceNumbers[`${claim.id}/${evidence.id}`],
    ),
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
    (claim) => claim.status === "zur_adjudikation",
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
    isGeprueft: openCount === 0,
  };
}
