import { randomUUID } from "node:crypto";

import type { Source, SourceType } from "../../register";
import {
  RunActiveError,
  SourceCorrectionPreconditionError,
  UnknownSourceError,
} from "../errors";
import { requireProjectStore } from "../projects";
import { hasCaptureInFlight } from "../runs/auto-chain";
import type { CaptureChainAccess } from "../runs/auto-chain";
import { describeBlockingActivity } from "../runs/control";
import { getGlobalJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
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

export interface CorrectSourceMetadataInput {
  projectId: string;
  /** The EXISTING source whose bibliographic core is being replaced — the id
   * is kept, so every citing claim's evidence stays valid. */
  sourceId: string;
  kind: CaptureKind;
  /** Corrected DOI, arXiv id or URL; unused for the upload kind, which
   * carries its metadata in `manual`. */
  identifier?: string;
  /** Reclassification alongside the fix; omitted keeps the current
   * source_type. */
  sourceType?: SourceType;
  /** Manual bibliographic metadata; required for url/upload corrections. */
  manual?: ManualMetadata;
  // Deliberately NO upload, documentUrl, expectedExt or correctionAttemptId:
  // this path never acquires a document and never runs as a work item, so
  // there is no attempt to be handed one from outside.
}

export interface CorrectSourceMetadataResult {
  source: Source;
  /** The frozen document's snapshot revision — UNCHANGED by this use-case.
   * Named `revision`, not `newRevision`, precisely because nothing advanced:
   * a field named "new" would invite a caller to render it as one. */
  revision: number;
  /** Claims pulled back to recheck_required — the settled statuses plus
   * those stuck in adjudication via a failed existence check. */
  recheckedClaimIds: string[];
}

export interface CorrectSourceMetadataDependencies extends CaptureDependencies {
  runner?: JobRunner;
  /** Injectable capture chain slice for the in-flight precondition; the
   * process-global chain in production. */
  chain?: CaptureChainAccess;
}

/**
 * Corrects a captured source's bibliographic identity ONLY (source
 * correction, metadata mode): the source gets a NEW bibliographic core
 * resolved from the corrected input while its frozen document stays exactly
 * as it is — same blob, same checksum, same snapshot revision. The
 * superseded core moves to `custom.previous_identities`; nothing is
 * appended to `custom.previous_snapshots`, and `source_set_revision` does
 * not move, because no document rotated.
 *
 * The case this exists for: the right document was captured under the wrong
 * DOI. Until now the only way to fix the identity was correctSource, which
 * re-acquires a document — so fixing the metadata forced the user to hand
 * over the PDF again and rotated a snapshot that was never wrong.
 *
 * SYNCHRONOUS, mirroring reviseSource, and deliberately not a queued work
 * item: a durable work item would have to be rebuildable from
 * `CaptureFailureInput` on retry, and for the arxiv and url kinds a
 * metadata-only correction is indistinguishable there from a combined one
 * (both legitimately carry no upload and no document_url) — a retry would
 * silently re-fetch and replace the document the user deliberately kept.
 * Staying synchronous dissolves that instead of paying for a schema field
 * to patch it.
 */
export async function correctSourceMetadata(
  input: CorrectSourceMetadataInput,
  deps: CorrectSourceMetadataDependencies = {},
): Promise<CorrectSourceMetadataResult> {
  const fetcher = deps.fetcher ?? nodeHttpFetcher;
  const runner = deps.runner ?? getGlobalJobRunner();
  // correctSource needs no such guard because it runs inside the queued
  // single-writer run and inherits that exclusivity. This one is called
  // straight from a server action, so it must assert exclusivity itself —
  // the same pair, and for the same reason, as reviseSource: a run caches
  // the sources at run start, and a mid-run identity change would let it
  // validate claims against a source it no longer describes.
  const blocking = describeBlockingActivity(input.projectId);
  if (blocking || runner.isRunning(input.projectId)) {
    throw new RunActiveError(input.projectId, blocking);
  }
  if (
    hasCaptureInFlight(
      input.projectId,
      (item) => item.targetSourceId === input.sourceId,
      deps.chain,
    )
  ) {
    // Same wording enqueueSourceCorrection uses: one situation, one
    // sentence, whichever mode the user came from.
    throw new SourceCorrectionPreconditionError(
      `Für Quelle "${input.sourceId}" läuft bereits eine Korrektur – ` +
        "bitte deren Abschluss abwarten.",
    );
  }

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

  // Impure work strictly outside any transaction, and limited to the
  // identity: no acquireDocument, no extraction, no blob write anywhere on
  // this path — that limitation IS the mode.
  const { resolved, verified } = await resolveMetadata(input, fetcher);
  const now = new Date().toISOString();
  // Minted here rather than accepted from the caller: there is no work item
  // to take an id from, but `custom.correction_attempt_id` must stay
  // populated so the accompanying source_identity_corrected event keeps
  // resolving earlier source_capture_failed events for this source.
  const correctionAttemptId = `wi_${randomUUID()}`;

  return store.transaction((tx) => {
    // TOCTOU re-checks under the lock, mirroring correctSource.
    const lockedSource = tx
      .listSources()
      .find((candidate) => candidate.id === input.sourceId);
    const lockedSnapshot = lockedSource?.custom.snapshot;
    if (!lockedSource) {
      throw new UnknownSourceError(input.sourceId);
    }
    if (!lockedSnapshot) {
      throw new SourceCorrectionPreconditionError(
        `Quelle "${input.sourceId}" hat keine eingefrorene Fassung – ` +
          "ohne eingefrorenen Stand gibt es nichts zu korrigieren.",
      );
    }
    // tx.reviseSource is deliberately NOT called, and neither is
    // store.blobs().put: the document is not part of this correction.
    const { previousItem, newItem } = tx.correctSourceIdentity(input.sourceId, {
      item: resolved.item,
      replacedAt: now,
      ...(verified ? { identifierVerified: { status: true, at: now } } : {}),
      correctionAttemptId,
      ...(input.sourceType !== undefined
        ? { sourceType: input.sourceType }
        : {}),
    });
    const recheckedClaimIds = sweepSourceRecheck(tx, input.sourceId, {
      actor: CORRECTION_ACTOR,
      at: now,
      reason:
        `Korrektur der Quellenkennung von ${input.sourceId} ` +
        "(nur bibliografische Angaben, eingefrorenes Dokument unverändert): " +
        "bisherige Prüfung bezog sich auf die fehlerhafte Kennung.",
      includeExistenceCheckRouting: true,
    });
    tx.recordIdentityCorrection({
      source_id: input.sourceId,
      previous_item: previousItem,
      new_item: newItem,
      // The equal pair is the point, not a bug: IdentityChange constrains
      // both ends to z.int().min(1) and imposes no from !== to, so a
      // correction that rotates nothing is expressible with NO register
      // schema change. revertSourceIdentity reads exactly this pair to
      // decide whether a document must be restored — an unequal pair here
      // would make it rotate a snapshot this correction never replaced.
      snapshot_revision: {
        from: lockedSnapshot.revision,
        to: lockedSnapshot.revision,
      },
      recheck_claim_ids: recheckedClaimIds,
      actor: CORRECTION_ACTOR,
      reason:
        `Quellenkennung von ${input.sourceId} korrigiert – ` +
        "eingefrorenes Dokument unverändert, " +
        `${recheckedClaimIds.length} Aussage(n) zur Nachprüfung markiert.`,
      at: now,
    });
    const corrected = tx
      .listSources()
      .find((candidate) => candidate.id === input.sourceId);
    return {
      source: structuredClone(corrected) as Source,
      revision: lockedSnapshot.revision,
      recheckedClaimIds,
    };
  });
}
