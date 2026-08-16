import type { CaptureFailure, TriggerKind } from "../../register";
import { requireProjectStore } from "../projects";
import { runKindLabel } from "./labels";

/** Actor of every chain-bracket write (run visibility). */
export const AUTO_CHAIN_ACTOR = "system:auto_chain" as const;

/**
 * Durable start/end brackets for the auto-chain's work (run visibility),
 * reusing the `batch_run_started`/`batch_run_completed` event pair with
 * `trigger_kind` as the discriminator — the extraction brackets predate the
 * field and stay recognizable unchanged.
 *
 * The contract that makes an unclosed bracket MEANINGFUL: the close is
 * written when the trigger's own work settles — not when the chain stops
 * waiting for it. An abandoned (cancelled or deadline-expired) trigger
 * therefore leaves its bracket open exactly as a crash does, the derivation
 * reads both as "interrupted", and if the abandoned work later settles on
 * its own, its close lands late and the derivation self-heals on the next
 * read. One mechanism for crash, cancel and timeout alike.
 *
 * Bracket writes are visibility, not function: a failed write warns and
 * never breaks the trigger it describes.
 */
export async function openTriggerBracket(options: {
  projectId: string;
  kind: TriggerKind;
  sourceId?: string;
  workItemId?: string;
  /** Only for `source_capture`: the retryable input, snapshotted at START
   * so an attempt cut off before its own failure event stays retryable. */
  captureAttempt?: CaptureFailure;
}): Promise<void> {
  const { projectId, kind, sourceId, workItemId, captureAttempt } = options;
  try {
    const store = requireProjectStore(projectId);
    await store.transaction((tx) => {
      tx.recordProjectEvent({
        event: "batch_run_started",
        actor: AUTO_CHAIN_ACTOR,
        reason: `${runKindLabel(kind)} gestartet (Folgeschritt der Verarbeitungskette).`,
        trigger_kind: kind,
        ...(sourceId !== undefined ? { source_id: sourceId } : {}),
        ...(workItemId !== undefined ? { work_item_id: workItemId } : {}),
        ...(captureAttempt !== undefined
          ? { capture_attempt: captureAttempt }
          : {}),
      });
    });
  } catch (error) {
    console.warn(
      `trigger bracket: start for ${kind} on "${projectId}" failed to record`,
      error,
    );
  }
}

export async function closeTriggerBracket(options: {
  projectId: string;
  kind: TriggerKind;
  sourceId?: string;
  workItemId?: string;
  outcome: "completed" | "failed";
}): Promise<void> {
  const { projectId, kind, sourceId, workItemId, outcome } = options;
  try {
    const store = requireProjectStore(projectId);
    await store.transaction((tx) => {
      tx.recordProjectEvent({
        event: "batch_run_completed",
        actor: AUTO_CHAIN_ACTOR,
        reason:
          outcome === "completed"
            ? `${runKindLabel(kind)} abgeschlossen.`
            : `${runKindLabel(kind)} fehlgeschlagen; Einzelheiten im Serverprotokoll.`,
        trigger_kind: kind,
        ...(sourceId !== undefined ? { source_id: sourceId } : {}),
        ...(workItemId !== undefined ? { work_item_id: workItemId } : {}),
      });
    });
  } catch (error) {
    console.warn(
      `trigger bracket: close for ${kind} on "${projectId}" failed to record`,
      error,
    );
  }
}
