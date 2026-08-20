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
 * `custom.previous_identities` becomes current again, together with the
 * document that correction replaced — if it replaced one.
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
 * The archived DOCUMENT is required exactly when the correction rotated
 * one. A correction that only replaced the bibliographic identity left the
 * frozen document alone, so there is nothing to restore and rotating now
 * would invent a revision; a correction that DID rotate the document must
 * bring its predecessor back, or the metadata would describe one work and
 * the frozen text another — precisely the state this is meant to end.
 * Which of the two happened is read from the correction's own event, never
 * inferred from the archives.
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
    // .at(-1) is sound HERE and only here: `previous_identities` is appended
    // to by tx.correctSourceIdentity alone, so its last entry IS the identity
    // the last correction replaced. Do NOT re-symmetrize the next line onto
    // `previous_snapshots` — that array is appended to by tx.reviseSource, an
    // independent capability, so any plain revision between the correction and
    // this revert leaves its last entry pointing at a document the correction
    // never touched. Pairing the two by position is the bug this replaced.
    const archivedIdentity = locked?.custom.previous_identities?.at(-1);
    const currentSnapshot = locked?.custom.snapshot;
    if (!locked || !currentSnapshot) {
      throw new UnknownSourceError(sourceId);
    }
    if (!archivedIdentity) {
      throw new PipelineError(
        `Quelle "${sourceId}" hat keine frühere Kennung, die ` +
          "wiederhergestellt werden könnte.",
      );
    }
    // Which document belongs to the archived identity is RECORDED, not
    // inferred: the correction's own event names the snapshot revision it
    // replaced. Fail closed without it — guessing is what this fix removes.
    const correction = tx
      .listProjectEvents()
      .findLast(
        (event) =>
          event.event === "source_identity_corrected" &&
          event.identity_change?.source_id === sourceId,
      )?.identity_change;
    if (!correction) {
      throw new PipelineError(
        `Zur früheren Kennung von Quelle "${sourceId}" ist keine Korrektur ` +
          "verzeichnet – ohne sie lässt sich der zugehörige Dokumentstand " +
          "nicht bestimmen.",
      );
    }
    // from === to means the correction replaced the identity only (a
    // metadata-only correction) — nothing to restore, and rotating now would
    // invent a revision.
    const { from, to } = correction.snapshot_revision;
    const rotated = from !== to;
    const archivedSnapshot = rotated
      ? locked.custom.previous_snapshots?.find(
          (snapshot) => snapshot.revision === from,
        )
      : undefined;
    if (rotated && !archivedSnapshot) {
      throw new PipelineError(
        `Der Dokumentstand (Fassung ${from}), den die Kennungskorrektur von ` +
          `Quelle "${sourceId}" ersetzt hat, ist nicht archiviert – die ` +
          "frühere Kennung lässt sich nicht vollständig wiederherstellen.",
      );
    }

    const newRevision = archivedSnapshot
      ? currentSnapshot.revision + 1
      : currentSnapshot.revision;
    if (archivedSnapshot) {
      tx.reviseSource(sourceId, { ...archivedSnapshot, revision: newRevision });
    }
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
      reason: rotated
        ? `Rücknahme der Kennungskorrektur von ${sourceId} ` +
          `(Snapshot-Revision ${currentSnapshot.revision} → ${newRevision}): ` +
          "die bisherige Prüfung bezog sich auf die verworfene Kennung."
        : `Rücknahme der Kennungskorrektur von ${sourceId}: ` +
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
      reason: rotated
        ? `Kennungskorrektur von ${sourceId} zurückgenommen – frühere ` +
          `Kennung und zugehöriges Dokument wiederhergestellt, ` +
          `${recheckedClaimIds.length} Aussage(n) zur Nachprüfung markiert.`
        : `Kennungskorrektur von ${sourceId} zurückgenommen – frühere ` +
          `Kennung wiederhergestellt, eingefrorenes Dokument unverändert, ` +
          `${recheckedClaimIds.length} Aussage(n) zur Nachprüfung markiert.`,
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
