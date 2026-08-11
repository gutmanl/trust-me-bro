import type { Claim, ClaimsRegister, Source } from "../../register";
import { requireProjectStore } from "../projects";
import { getGlobalJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import type { RunHandle } from "../runs/types";
import type { HttpFetcher } from "../sources/fetch-port";
import { nodeHttpFetcher } from "../sources/node-http-fetcher";
import { runStage1ForClaim } from "./stage1/run-stage1-claim";
import type { Stage1Context } from "./stage1/run-stage1-claim";
import type { SourceCheckCache } from "./stage1/source-check";

/**
 * Standalone stage 1 (deterministic, LLM-free) existence check (workbench
 * epic): one job-runner item per claim currently `captured` or
 * `recheck_required`, in register order — the same population the cascading
 * verification run's stage 1 touches, minus stages 2/3 and their backend
 * preflight (nothing here talks to an LLM, so there is nothing to preflight).
 * No project-event bracket: unlike the cascade, this run's completeness is
 * fully derivable from claim statuses alone (captured/recheck_required →
 * still open, existence_checked/pending_adjudication → done), so there is
 * nothing worth recording that the register does not already show.
 *
 * Each item's result is the RUNNING total so far — the last item_completed
 * event's result IS the run's summary, no separate aggregation needed.
 */
export interface ExistenceCheckSummary {
  checked: number;
  passed: number;
  failed: number;
}

export interface ExistenceCheckDependencies {
  runner?: JobRunner;
  fetcher?: HttpFetcher;
}

/** Claims stage 1 still needs to (re-)establish existence for: `captured`
 * (fresh from extraction) and `recheck_required` (TMB-44, pulled back in by
 * a source revision). Single-sourced so the run's item list and the open-
 * work counter can never disagree. */
function openExistenceCheckClaims(register: ClaimsRegister): Claim[] {
  return register.claims.filter(
    (claim) =>
      claim.status === "captured" || claim.status === "recheck_required",
  );
}

/** Number of claims still awaiting (or re-awaiting) stage 1 — recomputed
 * fresh from the register, like every other derived count in this
 * codebase. */
export function getOpenExistenceCheckCount(register: ClaimsRegister): number {
  return openExistenceCheckClaims(register).length;
}

export async function startExistenceCheck(
  projectId: string,
  deps: ExistenceCheckDependencies = {},
): Promise<RunHandle<ExistenceCheckSummary>> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const eligible = openExistenceCheckClaims(register);
  const runner = deps.runner ?? getGlobalJobRunner();
  const ctx: Stage1Context = {
    store,
    sourcesById: new Map(
      register.sources.map((source): [string, Source] => [source.id, source]),
    ),
    fetcher: deps.fetcher ?? nodeHttpFetcher,
    cache: new Map() as SourceCheckCache,
  };
  const running: ExistenceCheckSummary = { checked: 0, passed: 0, failed: 0 };

  return runner.submit(
    projectId,
    eligible.map((claim) => claim.id),
    (claimId) => claimId,
    (claimId) => processClaim(ctx, claimId, running),
    { kind: "existence_check" },
  );
}

async function processClaim(
  ctx: Stage1Context,
  claimId: string,
  running: ExistenceCheckSummary,
): Promise<ExistenceCheckSummary> {
  const claim = (await ctx.store.read()).claims.find(
    (candidate) => candidate.id === claimId,
  );
  if (
    !claim ||
    (claim.status !== "captured" && claim.status !== "recheck_required")
  ) {
    // Status changed since the run was submitted (e.g. an edit landed
    // between submission and this item) — leave the running total alone.
    return { ...running };
  }
  const updated = await runStage1ForClaim(claim, ctx);
  running.checked += 1;
  if (updated.status === "existence_checked") {
    running.passed += 1;
  } else {
    running.failed += 1;
  }
  return { ...running };
}
