import type { Claim, ClaimsRegister } from "../../register";

/**
 * Claims still needing verification work, recomputed fresh from the CURRENT
 * register on every run start — the resumability mechanism of the whole
 * epic: a crashed or paused run needs no bookkeeping of "where it stopped",
 * because each claim's status already says what remains. `erfasst` needs
 * stage 1 (always re-checked, it is cheap and deterministic);
 * `existenzgeprueft` needs stages 2+3.
 */
export function pickUnfinishedClaims(register: ClaimsRegister): Claim[] {
  return register.claims.filter(
    (claim) =>
      claim.status === "erfasst" || claim.status === "existenzgeprueft",
  );
}
