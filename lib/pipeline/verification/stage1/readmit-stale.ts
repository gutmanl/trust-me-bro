import type { Claim, ClaimsRegister, RegisterStore } from "../../../register";

/** Actor of the one-off readmission below. */
const READMIT_ACTOR = "system:existence_check" as const;

/**
 * Claims whose adjudication rests on an existence check that predates the
 * `match` field, i.e. one taken with the older wording comparison.
 *
 * The absence of `match` is the whole migration marker. Stage 1 now records
 * it on EVERY outcome, so a verdict reached since carries `exact`,
 * `interrupted` or `none` and is never selected here — which is what makes
 * the readmission run exactly once per claim instead of churning the
 * append-only chain on every pass.
 *
 * The `history.at(-1)` requirement is the same one the transition table's
 * gate and the correction sweep use, and it is doing real work: it means
 * only claims NOBODY has touched since the failed check are moved. A claim
 * a reviewer has already acted on stays exactly where they left it.
 */
export function claimsAwaitingRecheck(register: ClaimsRegister): Claim[] {
  return register.claims.filter(
    (claim) =>
      claim.status === "pending_adjudication" &&
      claim.history.at(-1)?.routing === "existence_check_failed" &&
      claim.evidence.some(
        (evidence) =>
          evidence.existence_check !== undefined &&
          evidence.existence_check.match === undefined,
      ),
  );
}

/**
 * Pulls those claims back into `recheck_required` so the run about to start
 * re-examines them (stage 1, wording comparison correction).
 *
 * Runs inside its own transaction before the run is submitted, and is a
 * no-op once every claim carries the newer marker. Returns the ids moved,
 * for the run's own reporting.
 */
export async function readmitStaleExistenceChecks(
  store: RegisterStore,
  register: ClaimsRegister,
): Promise<string[]> {
  const stale = claimsAwaitingRecheck(register);
  if (stale.length === 0) {
    return [];
  }
  await store.transaction((tx) => {
    for (const claim of stale) {
      // Re-derive under the lock: a human may have adjudicated one of these
      // between the read above and this transaction, and their verdict wins.
      const current = tx.getClaim(claim.id);
      if (
        current.status !== "pending_adjudication" ||
        current.history.at(-1)?.routing !== "existence_check_failed"
      ) {
        continue;
      }
      tx.transitionClaim(claim.id, {
        to: "recheck_required",
        actor: READMIT_ACTOR,
        reason:
          "Erneute Zitatprüfung: die frühere Prüfung verglich den " +
          "Wortlaut mit einer Normalform, die Trennstrich-Umbrüche und " +
          "Gedankenstriche am Zeilenende falsch auflöste.",
      });
    }
  });
  return stale.map((claim) => claim.id);
}
