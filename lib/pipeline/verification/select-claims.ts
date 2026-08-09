import type { Claim, ClaimsRegister } from "../../register";

/**
 * Claims still needing verification work, recomputed fresh from the CURRENT
 * register on every run start — the resumability mechanism of the whole
 * epic: a crashed or paused run needs no bookkeeping of "where it stopped",
 * because each claim's status already says what remains. `captured` needs
 * stage 1 (always re-checked, it is cheap and deterministic);
 * `existence_checked` needs stages 2+3; `recheck_required` (TMB-44)
 * re-enters the full cascade against the revised source text.
 */
export function pickUnfinishedClaims(register: ClaimsRegister): Claim[] {
  return register.claims.filter(
    (claim) =>
      claim.status === "captured" ||
      claim.status === "existence_checked" ||
      claim.status === "recheck_required",
  );
}
