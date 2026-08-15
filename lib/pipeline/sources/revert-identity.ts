import { randomUUID } from "node:crypto";

import type { Source } from "../../register";
import { PipelineError, UnknownSourceError } from "../errors";
import { requireProjectStore } from "../projects";
import { hasCaptureInFlight } from "../runs/auto-chain";
import type { CaptureChainAccess } from "../runs/auto-chain";
import { CORRECTION_ACTOR } from "./correction";
import { sweepSourceRecheck } from "./recheck";

export interface RevertSourceIdentityResult {
  source: Source;
  newRevision: number;
  recheckedClaimIds: string[];
}

/**
 * Undoes the most recent identity correction of a source (source
 * correction): the archived bibliographic core in
 * `custom.previous_identities` becomes current again, and the archived
 * document in `custom.previous_snapshots` with it.
 *
 * The case this exists for: an automatic repair proposes a candidate, a
 * reviewer accepts it, and the new identity turns out to be a different
 * work — at which point the source has both the wrong metadata AND the
 * wrong frozen document, and every claim citing it fails stage 1. Nothing
 * is lost when that happens (the register archives rather than overwrites),
 * but until now nothing could put it back either.
 *
 * NOT a rewrite of history: the revert is itself an audited correction. The
 * discarded identity moves into `previous_identities` in turn and the
 * snapshot revision advances, so the chain reads A → B → A rather than
 * pretending B never happened.
 *
 * Both halves are required. A source with an archived identity but no
 * archived document cannot be restored coherently — the metadata would
 * describe one work and the frozen text another, which is precisely the
 * state this is meant to end.
 */
export async function revertSourceIdentity(
  projectId: string,
  sourceId: string,
  deps: { chain?: CaptureChainAccess } = {},
): Promise<RevertSourceIdentityResult> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const source = register.sources.find((entry) => entry.id === sourceId);
  if (!source) {
    throw new UnknownSourceError(sourceId);
  }
  if (
    hasCaptureInFlight(
      projectId,
      (item) => item.targetSourceId === sourceId,
      deps.chain,
    )
  ) {
    throw new PipelineError(
      `Für Quelle "${sourceId}" läuft bereits eine Korrektur – ` +
        "bitte deren Abschluss abwarten.",
    );
  }

  const now = new Date().toISOString();
  return store.transaction((tx) => {
    // Re-read under the lock: the archives are what this acts on, and a
    // correction landing in between would change both of them.
    const locked = tx.listSources().find((entry) => entry.id === sourceId);
    const archivedIdentity = locked?.custom.previous_identities?.at(-1);
    const archivedSnapshot = locked?.custom.previous_snapshots?.at(-1);
    const currentSnapshot = locked?.custom.snapshot;
    if (!locked || !currentSnapshot) {
      throw new UnknownSourceError(sourceId);
    }
    if (!archivedIdentity || !archivedSnapshot) {
      throw new PipelineError(
        `Quelle "${sourceId}" hat keine frühere Kennung mit zugehörigem ` +
          "Dokument, die wiederhergestellt werden könnte.",
      );
    }

    const newRevision = currentSnapshot.revision + 1;
    tx.reviseSource(sourceId, { ...archivedSnapshot, revision: newRevision });
    const { previousItem, newItem } = tx.correctSourceIdentity(sourceId, {
      item: archivedIdentity.item,
      replacedAt: now,
      ...(archivedIdentity.identifier_verified !== undefined
        ? { identifierVerified: archivedIdentity.identifier_verified }
        : {}),
      correctionAttemptId: `wi_${randomUUID()}`,
    });
    const recheckedClaimIds = sweepSourceRecheck(tx, sourceId, {
      actor: CORRECTION_ACTOR,
      at: now,
      reason:
        `Rücknahme der Kennungskorrektur von ${sourceId} ` +
        `(Snapshot-Revision ${currentSnapshot.revision} → ${newRevision}): ` +
        "die bisherige Prüfung bezog sich auf die verworfene Kennung.",
      includeExistenceCheckRouting: true,
    });
    tx.recordIdentityCorrection({
      source_id: sourceId,
      previous_item: previousItem,
      new_item: newItem,
      snapshot_revision: { from: currentSnapshot.revision, to: newRevision },
      recheck_claim_ids: recheckedClaimIds,
      actor: CORRECTION_ACTOR,
      reason:
        `Kennungskorrektur von ${sourceId} zurückgenommen – frühere ` +
        `Kennung und zugehöriges Dokument wiederhergestellt, ` +
        `${recheckedClaimIds.length} Claim(s) zur Nachprüfung markiert.`,
      at: now,
    });
    const reverted = tx.listSources().find((entry) => entry.id === sourceId);
    return {
      source: structuredClone(reverted) as Source,
      newRevision,
      recheckedClaimIds,
    };
  });
}
