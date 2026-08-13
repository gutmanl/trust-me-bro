import type { ProjectEvent, ProjectEventType } from "../../register";

/**
 * Shared core of the register-derived run states (verification, relevance,
 * research, reference scan): a pair of project events brackets a run, and
 * the LAST started/completed pair decides the phase. The rules every
 * consumer relies on:
 *
 * - A live run (volatile runner knowledge) always reports `running` —
 *   the events only say what has been durably recorded.
 * - An opening bracket without a close (`lastCompleted` missing or older by
 *   `seq`) means the process was interrupted mid-run. Each derivation's
 *   restart semantics build on this being unambiguous, which it is because
 *   every writer records the completion event in the same transaction as
 *   its durable result.
 * - A closed bracket carries the completion's `at`/`reason`; what a close
 *   MEANS (completed, halted, failed …) is domain knowledge and stays with
 *   the caller.
 *
 * The union encodes the invariants — `interrupted` always has a start,
 * `closed` always has a completion — so callers need no assertions.
 */
export type RunBracket =
  | { phase: "not_started" }
  | { phase: "running"; startedAt: string | undefined }
  | { phase: "interrupted"; startedAt: string }
  | {
      phase: "closed";
      startedAt: string | undefined;
      completedAt: string;
      reason: string;
    };

export function deriveRunBracket(
  events: readonly ProjectEvent[],
  startedEvent: ProjectEventType,
  completedEvent: ProjectEventType,
  hasActiveRun: boolean,
): RunBracket {
  const lastStarted = events
    .filter((event) => event.event === startedEvent)
    .at(-1);
  const lastCompleted = events
    .filter((event) => event.event === completedEvent)
    .at(-1);

  if (hasActiveRun) {
    return { phase: "running", startedAt: lastStarted?.at };
  }
  if (lastStarted && (!lastCompleted || lastCompleted.seq < lastStarted.seq)) {
    return { phase: "interrupted", startedAt: lastStarted.at };
  }
  if (lastCompleted) {
    return {
      phase: "closed",
      startedAt: lastStarted?.at,
      completedAt: lastCompleted.at,
      reason: lastCompleted.reason,
    };
  }
  return { phase: "not_started" };
}
