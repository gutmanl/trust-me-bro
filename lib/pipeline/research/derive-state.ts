import type { ClaimsRegister } from "../../register";
import { deriveRunBracket } from "../runs/derive-bracket";

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
  const briefingPresent = register.project.briefing_import !== undefined;
  const bracket = deriveRunBracket(
    register.project_events,
    "research_run_started",
    "research_run_completed",
    hasActiveRun,
  );

  switch (bracket.phase) {
    case "running":
      return {
        status: "running",
        startedAt: bracket.startedAt,
        briefingPresent,
      };
    case "interrupted":
      return {
        status: "interrupted",
        startedAt: bracket.startedAt,
        briefingPresent,
      };
    case "closed":
      return {
        // A completed bracket with a briefing is a success; without one the
        // run reached its end without producing anything usable.
        status: briefingPresent ? "completed" : "failed",
        startedAt: bracket.startedAt,
        completedAt: bracket.completedAt,
        reason: bracket.reason,
        briefingPresent,
      };
    case "not_started":
      return { status: "not_started", briefingPresent };
  }
}
