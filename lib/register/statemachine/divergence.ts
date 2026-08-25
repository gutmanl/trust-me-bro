import type { RelationType } from "../schema/enums";
import type { Judgment } from "../schema/evidence";
import type { HistoryEntry } from "../schema/history";

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
 * The judgments authoritative for the claim's CURRENT wording: a judgment
 * recorded before the claim's last `revised` transition judged a superseded
 * text and must not gate the new one. Without this, a repair produced
 * phantom divergence: the primary backend confidently re-judged the revised
 * wording, the second opinion therefore never armed, and the secondary
 * backend's stale judgment of the OLD text read as disagreement — parking a
 * cleanly repaired claim as "Backend-Urteile widersprüchlich". The audit
 * trail keeps every judgment; only the resolution ignores superseded ones.
 * Claims never revised keep all judgments (no behaviour change).
 */
export function judgmentsForCurrentWording(
  claim: { history: readonly Pick<HistoryEntry, "to_status" | "at">[] },
  judgments: readonly Judgment[],
): Judgment[] {
  // Backwards loop instead of findLast: this file is compiled by the CLI
  // build too (tsconfig.cli.json, target ES2022), which predates findLast.
  let lastRevision: string | undefined;
  for (let index = claim.history.length - 1; index >= 0; index -= 1) {
    if (claim.history[index].to_status === "revised") {
      lastRevision = claim.history[index].at;
      break;
    }
  }
  if (lastRevision === undefined) {
    return [...judgments];
  }
  const cutoff = Date.parse(lastRevision);
  return judgments.filter((judgment) => Date.parse(judgment.at) >= cutoff);
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
