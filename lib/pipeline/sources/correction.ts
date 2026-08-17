import type { Source, SourceType } from "../../register";
import {
  SourceCorrectionPreconditionError,
  UnknownSourceError,
} from "../errors";
import { requireProjectStore } from "../projects";
import type { CaptureDependencies, CaptureKind } from "./capture";
import { resolveMetadata } from "./capture";
import type { ManualMetadata } from "./csl";
import { acquireDocument, buildSnapshot, extractTextOrError } from "./document";
import { nodeHttpFetcher } from "./node-http-fetcher";
import { sweepSourceRecheck } from "./recheck";

/** Actor of a correction's register writes (source correction): the
 * attempt runs detached inside the capture queue, like `system:capture` —
 * but under its own token, so the chain tells an identity correction from
 * an ordinary capture at a glance. */
export const CORRECTION_ACTOR = "system:source_correction";

export interface CorrectSourceInput {
  projectId: string;
  /** The EXISTING source whose identity is being replaced — the id is kept,
   * so every citing claim's evidence stays valid. */
  sourceId: string;
  kind: CaptureKind;
  /** Corrected DOI, arXiv id or URL; unused for uploads. */
  identifier?: string;
  /** Reclassification alongside the fix; omitted keeps the current
   * source_type. */
  sourceType?: SourceType;
  /** Manual bibliographic metadata; required for url/upload corrections. */
  manual?: ManualMetadata;
  /** Document URL when the identifier does not determine one (DOI). */
  documentUrl?: string;
  /** Corpus-integrity guard for auto-derived document URLs, exactly as on
   * capture. A correction freezes a document like any capture does, so it
   * needs the same protection: without it a publisher landing page answers
   * a PDF-shaped URL and is frozen as the paper. */
  expectedExt?: string;
  /** Corrected document; takes precedence over any URL. */
  upload?: { content: Buffer; filename: string };
  /** Work-item id of the correction attempt: written to
   * `custom.correction_attempt_id`; the accompanying
   * `source_identity_corrected` event resolves earlier
   * `source_capture_failed` events targeting the same source. */
  correctionAttemptId: string;
}

export interface CorrectSourceResult {
  source: Source;
  newRevision: number;
  /** Claims pulled back to recheck_required — the settled statuses plus
   * those stuck in adjudication via a failed existence check. */
  recheckedClaimIds: string[];
}

/**
 * Corrects a captured source's identity (source correction): a source
 * captured under a wrong — typically hallucinated — DOI/URL gets a NEW
 * bibliographic core resolved from the corrected input, a NEW frozen
 * document, and keeps its id. The superseded core moves to
 * `custom.previous_identities`, the superseded document to
 * `custom.previous_snapshots`; affected claims re-enter the cascade,
 * including those adjudication only holds because the wrong identity
 * failed their existence check.
 *
 * Unlike reviseSource there is deliberately NO checksum short-circuit: the
 * corrected identity fields are the point, and they must land even when
 * the re-acquired document happens to be byte-identical (e.g. the correct
 * PDF was already uploaded and only the DOI string was wrong).
 *
 * Always runs as a queued work item on the single-writer runner (no
 * RunActiveError guard needed — the run itself is the exclusivity), so the
 * register writes carry `CORRECTION_ACTOR`.
 */
export async function correctSource(
  input: CorrectSourceInput,
  deps: CaptureDependencies = {},
): Promise<CorrectSourceResult> {
  const fetcher = deps.fetcher ?? nodeHttpFetcher;
  const store = requireProjectStore(input.projectId);
  const register = await store.read();
  const source = register.sources.find(
    (candidate) => candidate.id === input.sourceId,
  );
  if (!source) {
    throw new UnknownSourceError(input.sourceId);
  }
  if (!source.custom.snapshot) {
    throw new SourceCorrectionPreconditionError(
      `Quelle "${input.sourceId}" hat keine eingefrorene Fassung – ` +
        "ohne eingefrorenen Stand gibt es nichts zu korrigieren.",
    );
  }

  // Impure work strictly outside any transaction, mirroring captureSource:
  // resolve the corrected identity, then acquire and extract the document.
  const { resolved, verified } = await resolveMetadata(input, fetcher);
  const document = await acquireDocument(
    {
      upload: input.upload,
      documentUrl: input.documentUrl?.trim() || resolved.documentUrl,
      expectedExt: input.expectedExt,
    },
    fetcher,
  );
  const extraction = await extractTextOrError(document.content, document.ext);
  const now = new Date().toISOString();

  return store.transaction((tx) => {
    // TOCTOU re-checks under the lock, mirroring reviseSource.
    const lockedSource = tx
      .listSources()
      .find((candidate) => candidate.id === input.sourceId);
    const lockedSnapshot = lockedSource?.custom.snapshot;
    if (!lockedSource || !lockedSnapshot) {
      throw new UnknownSourceError(input.sourceId);
    }
    const blob = store.blobs().put(document.content, document.ext);
    const newRevision = lockedSnapshot.revision + 1;
    tx.reviseSource(
      input.sourceId,
      buildSnapshot(store.blobs(), blob, extraction, newRevision, now),
    );
    const { previousItem, newItem } = tx.correctSourceIdentity(input.sourceId, {
      item: resolved.item,
      replacedAt: now,
      ...(verified ? { identifierVerified: { status: true, at: now } } : {}),
      correctionAttemptId: input.correctionAttemptId,
      ...(input.sourceType !== undefined
        ? { sourceType: input.sourceType }
        : {}),
    });
    const recheckedClaimIds = sweepSourceRecheck(tx, input.sourceId, {
      actor: CORRECTION_ACTOR,
      at: now,
      reason:
        `Korrektur der Quellenkennung von ${input.sourceId} ` +
        `(Snapshot-Revision ${lockedSnapshot.revision} → ${newRevision}): ` +
        "bisherige Prüfung bezog sich auf die fehlerhafte Kennung.",
      includeExistenceCheckRouting: true,
    });
    tx.recordIdentityCorrection({
      source_id: input.sourceId,
      previous_item: previousItem,
      new_item: newItem,
      snapshot_revision: { from: lockedSnapshot.revision, to: newRevision },
      recheck_claim_ids: recheckedClaimIds,
      actor: CORRECTION_ACTOR,
      reason:
        `Quellenkennung von ${input.sourceId} korrigiert – ` +
        `${recheckedClaimIds.length} Aussage(n) zur Nachprüfung markiert.`,
      at: now,
    });
    const corrected = tx
      .listSources()
      .find((candidate) => candidate.id === input.sourceId);
    return {
      source: structuredClone(corrected) as Source,
      newRevision,
      recheckedClaimIds,
    };
  });
}
