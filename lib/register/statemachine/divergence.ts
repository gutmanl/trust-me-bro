import type { RelationType } from "../schema/enums";
import type { Judgment } from "../schema/evidence";

/**
 * The divergence rule's core question, extracted as the single source of
 * truth for both sides: the state machine's auto-confirmation gate (is there
 * divergence?) and the verification pipeline (which relation may be written
 * as the resolved one?). Judgments accumulate append-only, so only the
 * CURRENT position of each backend counts — a backend revising its own
 * earlier judgment (e.g. after a repair re-run) must not read as divergence.
 */

/** Latest judgment per backend; later array position wins ties on equal
 * `at`, matching chain append order. */
export function latestJudgmentPerBackend(
  judgments: readonly Judgment[],
): Map<string, Judgment> {
  const latest = new Map<string, Judgment>();
  for (const judgment of judgments) {
    const current = latest.get(judgment.backend);
    if (!current || judgment.at >= current.at) {
      latest.set(judgment.backend, judgment);
    }
  }
  return latest;
}

/**
 * The relation currently authoritative for one piece of evidence, or null
 * when none is: no judgments yet, or the latest judgments per backend
 * disagree (divergence rule — resolution is then the adjudicator's decision,
 * never computed).
 */
export function resolveEvidenceRelation(
  judgments: readonly Judgment[],
): RelationType | null {
  const latest = latestJudgmentPerBackend(judgments);
  if (latest.size === 0) {
    return null;
  }
  const relations = new Set(
    [...latest.values()].map((judgment) => judgment.relation_type),
  );
  if (relations.size > 1) {
    return null;
  }
  return [...relations][0];
}
