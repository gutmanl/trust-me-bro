import type { ClaimsRegister } from "../../register";

/**
 * Extraction activity derived purely from the register (plus the volatile
 * "a live run exists" flag). Since the workbench epic extraction is no longer
 * a one-shot project phase but a repeatable per-source pass, so the old
 * not_started/completed state machine — which inferred success from "claims
 * exist" — no longer describes anything: after the first pass claims always
 * exist, and every further pass is legitimate. What the UI still needs is
 * only: is a pass running, and how did the last one end.
 *
 * The outcome is read off the LAST batch_run_completed event WRITTEN BY THE
 * EXTRACTION ACTOR, via the two reason prefixes below. Both writers of that
 * event live next to this module and use these constants, so the convention
 * has exactly one definition — the alternative, a new project event type per
 * outcome, would be a register format change for a purely cosmetic
 * distinction. The actor is part of the filter because the event type is
 * shared vocabulary while the prefixes are not: a batch completion recorded
 * by any other run kind carries neither prefix and would be misreported as a
 * completed extraction pass.
 */

/** Actor token both extraction writers record their events under — and the
 * one this module's outcome filter accepts, so the token has exactly one
 * definition, like the two reason prefixes below. */
export const EXTRACTION_ACTOR = "system:extraction" as const;

/** Prefix of the completion reason of a pass that committed its result. */
export const EXTRACTION_COMPLETED_PREFIX = "Aussagen-Erfassung abgeschlossen";

/** Prefix of the completion reason of a pass that produced nothing (backend
 * exhausted, rate-limited, or a bundle the register rejected as a whole). */
export const EXTRACTION_FAILED_PREFIX = "Aussagen-Erfassung ohne Ergebnis";

/** Failed prefix as written before the display-tier rename — registers are
 * append-only, so events carrying it exist forever and must keep deriving
 * as failures. */
const LEGACY_FAILED_PREFIX = "Claim-Extraktion ohne Ergebnis";

function isFailedReason(reason: string): boolean {
  return (
    reason.startsWith(EXTRACTION_FAILED_PREFIX) ||
    reason.startsWith(LEGACY_FAILED_PREFIX)
  );
}

export interface ExtractionActivity {
  running: boolean;
  lastOutcome: "completed" | "failed" | null;
  /** Reason of the last batch_run_completed event, as shown to the user. */
  lastMessage: string | null;
}

export function deriveExtractionActivity(
  register: ClaimsRegister,
  runnerRunning: boolean,
): ExtractionActivity {
  const lastCompleted = register.project_events
    .filter(
      (event) =>
        event.event === "batch_run_completed" &&
        event.actor === EXTRACTION_ACTOR,
    )
    .at(-1);
  if (!lastCompleted) {
    return { running: runnerRunning, lastOutcome: null, lastMessage: null };
  }
  return {
    running: runnerRunning,
    lastOutcome: isFailedReason(lastCompleted.reason) ? "failed" : "completed",
    lastMessage: lastCompleted.reason,
  };
}

/** How each source's LAST extraction pass ended, keyed by source id — read
 * off the structured `source_id` the bracket events carry since the source
 * work items extension. Events from before that extension have no
 * `source_id` and stay out on purpose: better no per-row verdict than one
 * inferred from parsing German prose. Sweep completions (no source) never
 * appear here; `deriveExtractionActivity` remains their home. */
export function deriveSourceExtractionOutcomes(
  register: ClaimsRegister,
): Map<string, { outcome: "completed" | "failed"; message: string }> {
  const outcomes = new Map<
    string,
    { outcome: "completed" | "failed"; message: string }
  >();
  for (const event of register.project_events) {
    if (
      event.event !== "batch_run_completed" ||
      event.actor !== EXTRACTION_ACTOR ||
      event.source_id === undefined
    ) {
      continue;
    }
    outcomes.set(event.source_id, {
      outcome: isFailedReason(event.reason) ? "failed" : "completed",
      message: event.reason,
    });
  }
  return outcomes;
}
