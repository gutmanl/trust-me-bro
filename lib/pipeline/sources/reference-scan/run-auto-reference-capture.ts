import type { JobRunner } from "../../runs/job-runner";
import type { RunHandle } from "../../runs/types";
import { getReferenceCandidates } from "./read-candidates";
import type { ReviewCandidate } from "./review";
import { startReferenceCapture } from "./run-reference-capture";
import type {
  ReferenceCaptureItemResult,
  ReferenceCaptureSelection,
} from "./run-reference-capture";

/**
 * Automatic half of the reference auto-import: the capture the auto-chain
 * starts by itself after the scan that follows a briefing publish, without
 * anyone having reviewed the candidate list.
 *
 * Internal on purpose. The barrel keeps exposing `startReferenceCapture`
 * for the review form — the run a human's actual selection starts — while
 * the automatic path reaches this module only through the auto-chain.
 */

/**
 * The policy question this feature turns on: which candidates does the
 * machine capture without a human having looked at them?
 *
 * Answer, deliberately borrowed rather than invented: exactly the ones the
 * review form pre-checks (`buildCandidateReview`'s `selected`, minus the
 * ones already captured), submitted with the same defaults an untouched
 * form submit would send — the candidate's suggested source type and NO
 * title/document-url/upload override. Automatic capture is therefore
 * bit-for-bit "the review form, submitted unmodified", and can never take a
 * candidate the form would have left unchecked: an `unresolved` citation, a
 * title-less URL, or a Crossref title match below CONFIDENT_THRESHOLD all
 * stay behind for the human, who completes them in the review list as
 * before.
 *
 * A named pure function rather than an inline filter in the auto-chain,
 * because this is the one place in the system where a document is frozen as
 * evidence with no human in the loop — the rule deserves to be readable and
 * tested in one place, not grepped out of a trigger handler.
 */
export function selectAutoCaptures(
  candidates: readonly ReviewCandidate[],
): ReferenceCaptureSelection[] {
  return candidates
    .filter((candidate) => candidate.selected && !candidate.alreadyCaptured)
    .map((candidate) => ({
      candidateId: candidate.candidate_id,
      sourceType: candidate.suggested_source_type,
    }));
}

export interface AutoReferenceCaptureDependencies {
  runner?: JobRunner;
  getReferenceCandidates?: typeof getReferenceCandidates;
  startReferenceCapture?: typeof startReferenceCapture;
}

/**
 * Captures the current scan's automatically resolvable candidates.
 *
 * Reads the candidates FRESH (not from whatever the scan returned): the
 * review projection re-derives `alreadyCaptured` against the register's
 * current source list, so a source captured by hand between the scan and
 * this run is seen and skipped, the same discipline the existence check
 * follows when it re-derives its worklist per run.
 *
 * Returns undefined WITHOUT starting a run when nothing qualifies — no
 * scan yet, a scan with no candidates, or a candidate list where every
 * entry needs a human. That case is the expected outcome of a briefing
 * citing nothing resolvable, not a caller mistake, so it must not surface
 * as `startReferenceCapture`'s ReferenceCapturePreconditionError (which the
 * auto-chain would then log as a failed trigger).
 */
export async function startAutoReferenceCapture(
  projectId: string,
  deps: AutoReferenceCaptureDependencies = {},
): Promise<RunHandle<ReferenceCaptureItemResult> | undefined> {
  const readCandidates = deps.getReferenceCandidates ?? getReferenceCandidates;
  const startCapture = deps.startReferenceCapture ?? startReferenceCapture;

  const selections = selectAutoCaptures(await readCandidates(projectId));
  if (selections.length === 0) {
    return undefined;
  }
  return startCapture(projectId, selections, {
    ...(deps.runner ? { runner: deps.runner } : {}),
  });
}
