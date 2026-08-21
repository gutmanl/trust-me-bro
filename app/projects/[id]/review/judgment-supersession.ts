import type { Judgment, RelationType } from "@/lib/register";

/**
 * Display-tier derivation over the append-only `Evidence.judgments` array:
 * has a backend changed its own mind, and what did it say before?
 *
 * The split this module exists to make, because a later reader will
 * otherwise try to reuse the gate: `resolveEvidenceRelation`
 * (`lib/register/statemachine/divergence.ts`) answers „what is
 * authoritative?" and must keep using `latestJudgmentPerBackend` — a backend
 * revising its own earlier judgment must NOT read as divergence. That is
 * correct for the transition gate, and it is precisely why the earlier
 * machine opinion becomes invisible in the UI. This function answers a
 * different question — „what has this system concluded over time?" — and is
 * display-tier only. Do not touch `divergence.ts`.
 *
 * No schema change and no pipeline change: the array is already there.
 *
 * The note this feeds states WHAT changed and WHEN. It says nothing about
 * which of the two judgments is better — that is the reviewer's call, and it
 * is exactly the call this tool exists to support.
 */
export interface SupersededJudgment {
  backend: string;
  previousRelation: RelationType;
  previousAt: string;
  currentRelation: RelationType;
  currentAt: string;
}

/**
 * One entry per backend whose newest judgment disagrees with its own
 * immediately previous one, in first-appearance order of the backends so the
 * rendered note order is deterministic.
 *
 * Cross-backend disagreement is NOT reported here: that is divergence, and
 * the card already reports it through `EvidenceDisplay.divergent`. Reporting
 * it here too would double-report one fact and mislabel it as a
 * self-revision — attributing a statement to an actor that never made it, in
 * a register that feeds the thesis attribution statistics.
 *
 * Never take `judgments.at(-1)` over the whole array to find „the previous"
 * judgment. With two backends that compares a `codex` judgment against a
 * `claude` one and produces exactly the mislabelling above.
 *
 * Array order is chronological: the register is append-only and its chain is
 * gapless. Do NOT sort by `at` — a sort would silently reorder two judgments
 * sharing a timestamp.
 */
export function deriveSupersededJudgments(
  judgments: readonly Judgment[],
): SupersededJudgment[] {
  const byBackend = new Map<string, Judgment[]>();
  for (const judgment of judgments) {
    const existing = byBackend.get(judgment.backend);
    if (existing === undefined) {
      byBackend.set(judgment.backend, [judgment]);
    } else {
      existing.push(judgment);
    }
  }

  const superseded: SupersededJudgment[] = [];
  for (const [backend, history] of byBackend) {
    if (history.length < 2) {
      continue;
    }
    const current = history[history.length - 1];
    const previous = history[history.length - 2];
    if (previous.relation_type === current.relation_type) {
      continue; // a re-run that reached the same conclusion superseded nothing
    }
    superseded.push({
      backend,
      previousRelation: previous.relation_type,
      previousAt: previous.at,
      currentRelation: current.relation_type,
      currentAt: current.at,
    });
  }
  return superseded;
}
