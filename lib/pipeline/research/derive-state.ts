import type { ClaimsRegister } from "../../register";

/**
 * Research state derived purely from the register, exactly like the
 * extraction and relevance states: the two research events bracket a run,
 * and the briefing import is the durable result. No separate run store —
 * a crash leaves a state that is still fully readable from claims.json.
 *
 * The bracket invariant matches extraction's: the briefing is frozen before
 * the completion event, so a start without a close means the run did not
 * finish and may safely be repeated — unless a briefing exists, in which
 * case the freeze did happen and repeating is refused anyway.
 */

export type ResearchStatus =
  "not_started" | "running" | "interrupted" | "failed" | "completed";

export interface ResearchState {
  status: ResearchStatus;
  startedAt?: string;
  completedAt?: string;
  /** Reason of the last research_run_completed event. */
  reason?: string;
  /** True once a briefing exists — from this run or from a manual import. */
  briefingPresent: boolean;
}

export function deriveResearchState(
  register: ClaimsRegister,
  hasActiveRun: boolean,
): ResearchState {
  const started = register.project_events.filter(
    (event) => event.event === "research_run_started",
  );
  const completed = register.project_events.filter(
    (event) => event.event === "research_run_completed",
  );
  const lastStarted = started.at(-1);
  const lastCompleted = completed.at(-1);
  const briefingPresent = register.project.briefing_import !== undefined;

  if (hasActiveRun) {
    return { status: "running", startedAt: lastStarted?.at, briefingPresent };
  }
  if (lastStarted && (!lastCompleted || lastCompleted.seq < lastStarted.seq)) {
    return {
      status: "interrupted",
      startedAt: lastStarted.at,
      briefingPresent,
    };
  }
  if (lastCompleted) {
    return {
      // A completed bracket with a briefing is a success; without one the
      // run reached its end without producing anything usable.
      status: briefingPresent ? "completed" : "failed",
      startedAt: lastStarted?.at,
      completedAt: lastCompleted.at,
      reason: lastCompleted.reason,
      briefingPresent,
    };
  }
  return { status: "not_started", briefingPresent };
}
