import {
  containsNormalized,
  findFuzzyParagraph,
  quoteContainmentScore,
  splitBriefingParagraphs,
} from "../../register";
import { requireProjectStore } from "../projects";

/** Actor of the automatic re-anchor sweep's audited events — distinct from
 * the human anchor repair and from the briefing revision's silent exact
 * remap, so the chain tells the three apart at a glance. */
export const ANCHOR_REPAIR_ACTOR = "system:anchor_repair";

export interface FuzzyReanchorSummary {
  /** Claims whose anchor the sweep repaired. */
  repaired: number;
  /** Claims whose quote still resolves nowhere, even fuzzily — they stay
   * in the briefing view's unanchored bucket for a human. */
  stillUnresolved: number;
}

/**
 * Automatic near-verbatim re-anchoring (anchor auto-repair): claims whose
 * `anchor_quote` occurs in NO briefing paragraph verbatim — the `p0`
 * sentinel from extraction, or a quote orphaned by a briefing revision —
 * get one bounded fuzzy attempt (`findFuzzyParagraph`, strict threshold).
 * A hit becomes an AUDITED `claim_anchor_revised` event under
 * `ANCHOR_REPAIR_ACTOR`, unlike the revision's silent exact remap: a
 * fuzzy match is a judgment call worth recording, not a mechanical
 * consequence. Misses stay untouched and visible via the briefing view's
 * existing unanchored bucket. Never touches `claim.status`.
 *
 * Claims whose quote still resolves verbatim somewhere are skipped even
 * when their anchor HINT is stale — the briefing view resolves
 * quote-first, so no display problem exists and the chain stays free of
 * no-op corrections.
 */
export async function runFuzzyReanchorSweep(
  projectId: string,
): Promise<FuzzyReanchorSummary> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const briefing = register.project.briefing_import;
  if (!briefing) {
    return { repaired: 0, stillUnresolved: 0 };
  }
  // Impure work (blob read) strictly before the transaction.
  const paragraphs = splitBriefingParagraphs(
    store.blobs().readText(briefing.blob_path),
  );

  const candidates = register.claims.flatMap((claim) => {
    const quote = claim.anchor_quote?.trim();
    if (claim.status === "discarded" || !quote) {
      return [];
    }
    if (paragraphs.some((paragraph) => containsNormalized(paragraph, quote))) {
      return [];
    }
    const index = findFuzzyParagraph(quote, paragraphs);
    return [{ claimId: claim.id, quote, index }];
  });

  const repairable = candidates.filter((candidate) => candidate.index !== null);
  if (repairable.length === 0) {
    return { repaired: 0, stillUnresolved: candidates.length };
  }

  await store.transaction((tx) => {
    for (const candidate of repairable) {
      const index = candidate.index as number;
      const score = quoteContainmentScore(candidate.quote, paragraphs[index]);
      tx.reviseClaimAnchor(candidate.claimId, {
        new_anchor: `p${index + 1}`,
        actor: ANCHOR_REPAIR_ACTOR,
        reason:
          `Automatisch neu zugeordnet: Zitat nicht mehr wörtlich ` +
          `im Briefing, aber mit hoher Ähnlichkeit in Absatz p${index + 1} ` +
          `gefunden (Übereinstimmung ${Math.round(score * 100)} %).`,
      });
    }
  });

  return {
    repaired: repairable.length,
    stillUnresolved: candidates.length - repairable.length,
  };
}
