import type { Claim, RegisterStore, Source } from "../../../register";
import type { HttpFetcher } from "../../sources/fetch-port";
import { checkClaimExistence } from "./existence-check";
import type { SourceCheckCache } from "./source-check";

const ACTOR_STAGE1 = "system:existence_check" as const;

/**
 * Everything stage 1 needs, mirrored exactly from what the cascading
 * verification run's per-claim block closed over (run-verification.ts).
 */
export interface Stage1Context {
  store: RegisterStore;
  sourcesById: ReadonlyMap<string, Source>;
  fetcher: HttpFetcher;
  cache: SourceCheckCache;
}

/**
 * Stage 1 (TMB-27/TMB-4), deterministic and LLM-free, for one claim already
 * in `captured` or `recheck_required` — extracted verbatim from the
 * cascading verification run (run-verification.ts) so it and the standalone
 * existence-check run share the exact same mechanics.
 *
 * `recheck_required` re-enters via the existing recheck_required→captured
 * transition (a source revision can invalidate ANY stage's determination,
 * so re-entry always restarts the cascade at captured) before stage 1 runs.
 * The stage-1 facts (per-evidence existence-check results) and the earned
 * transition — existence_checked when every piece of evidence is proven,
 * pending_adjudication otherwise — commit together in ONE transaction, same
 * discipline as every other stage of the pipeline. Returns the post-
 * transaction claim so a caller never needs a second read to see the
 * outcome (its `status` is exactly "existence_checked" or
 * "pending_adjudication").
 */
export async function runStage1ForClaim(
  claim: Claim,
  ctx: Stage1Context,
): Promise<Claim> {
  const claimId = claim.id;

  // Recheck (TMB-44): re-admit to the full cascade — the revised source
  // text can invalidate any stage's determination, so the claim re-enters
  // at captured and rides the existing pipeline unchanged.
  if (claim.status === "recheck_required") {
    claim = await ctx.store.transaction((tx) => {
      tx.transitionClaim(claimId, {
        to: "captured",
        actor: ACTOR_STAGE1,
        reason:
          "Wiederaufnahme der Prüfung (Stufe 1) nach Bestandsfassung der Quelle(n).",
      });
      return tx.getClaim(claimId);
    });
  }

  const results = await checkClaimExistence(claim, ctx.sourcesById, {
    blobs: ctx.store.blobs(),
    fetcher: ctx.fetcher,
    cache: ctx.cache,
  });
  const failures = results.filter((result) => result.status !== "passed");
  const now = new Date().toISOString();
  return ctx.store.transaction((tx) => {
    for (const result of results) {
      tx.setExistenceCheck(claimId, result.evidenceId, {
        status: result.status,
        at: now,
        match: result.match,
      });
    }
    tx.transitionClaim(claimId, {
      to: failures.length === 0 ? "existence_checked" : "pending_adjudication",
      actor: ACTOR_STAGE1,
      reason:
        failures.length === 0
          ? "Zitatprüfung bestanden: alle Belege im eingefrorenen Bestand nachgewiesen."
          : `Zitatprüfung nicht bestanden: ${failures
              .map((failure) => failure.detail)
              .join(" ")}`,
      ...(failures.length > 0
        ? { routing: "existence_check_failed" as const }
        : {}),
    });
    return tx.getClaim(claimId);
  });
}
