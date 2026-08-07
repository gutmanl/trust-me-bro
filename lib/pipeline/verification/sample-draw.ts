import type { Claim, ProjectEvent } from "../../register";

/**
 * Deterministic sample draw of automatically confirmed claims (TMB-32,
 * RQ3): FNV-1a string hash seeds a mulberry32 PRNG — reproducibility, not
 * cryptographic strength, is the requirement. The algorithm is part of the
 * reproducibility contract once runs exist (a pinned-seed regression test
 * guards it); the seed of a run is its runId, documented in the
 * verification_run_completed event.
 */

/**
 * Population of the sample draw, derived from the REGISTER, not from run
 * memory: claims currently automatisch_bestaetigt whose confirming history
 * entry lies after the last closed run bracket have never been subject to a
 * sample decision. In an uninterrupted run this is exactly the set the run
 * just confirmed; after a crash between the last claim and the draw it
 * additionally sweeps up the stranded confirmations of the dead run — no
 * claim escapes the Stichprobe because a process died at the wrong moment.
 */
export function pendingSamplePopulation(
  claims: readonly Claim[],
  projectEvents: readonly ProjectEvent[],
): string[] {
  const lastCompletedSeq = projectEvents
    .filter((event) => event.event === "verification_run_completed")
    .reduce((max, event) => Math.max(max, event.seq), 0);
  return claims
    .filter((claim) => claim.status === "automatisch_bestaetigt")
    .filter((claim) => {
      const confirmation = claim.history.findLast(
        (entry) => entry.to_status === "automatisch_bestaetigt",
      );
      return confirmation !== undefined && confirmation.seq > lastCompletedSeq;
    })
    .map((claim) => claim.id);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draws each claim independently with probability `rate`, iterating the ids
 * in sorted order so the result is independent of collection order. Rate 0
 * draws nothing, rate 1 draws all (acceptance criteria TMB-32).
 */
export function drawSample(
  claimIds: readonly string[],
  rate: number,
  seed: string,
): string[] {
  if (rate <= 0) {
    return [];
  }
  const random = mulberry32(fnv1a(seed));
  return [...claimIds].sort().filter(() => random() < rate);
}
