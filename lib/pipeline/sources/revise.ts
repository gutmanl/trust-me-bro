import { getCurrentActor } from "../../identity";
import {
  RunActiveError,
  SourceRevisionPreconditionError,
  UnknownSourceError,
} from "../errors";
import { requireProjectStore } from "../projects";
import { getGlobalJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import { acquireDocument, buildSnapshot, extractTextOrError } from "./document";
import type { CaptureDependencies } from "./capture";
import { nodeHttpFetcher } from "./node-http-fetcher";

export interface ReviseSourceInput {
  projectId: string;
  sourceId: string;
  /** Document URL to re-fetch from; unused when an upload is given. */
  documentUrl?: string;
  /** Fresh document upload; takes precedence over any URL. */
  upload?: { content: Buffer; filename: string };
}

export interface ReviseSourceResult {
  /** false = checksum-identical content: recognized, no revision, no
   * recheck, no register write (TMB-44 acceptance criterion). */
  revised: boolean;
  newRevision?: number;
  /** Claims marked recheck_required by this revision. */
  recheckedClaimIds: string[];
}

/** Claim statuses a source revision pulls into Nachprüfung: exactly the
 * settled machine/human determinations that referenced the old wording.
 * captured self-heals (stage 1 always re-runs), the adjudication/repair
 * statuses are mid human-workflow, discarded stays terminal. */
const RECHECK_STATUSES = new Set([
  "existence_checked",
  "prechecked",
  "auto_confirmed",
  "confirmed",
]);

/**
 * Revises a source (TMB-44): acquires the current document, and — only if
 * its checksum differs from the existing snapshot — rotates the snapshot to
 * a new revision (the old one moves to previous_snapshots and its blobs
 * stay in the store), advances the project-wide source_set_revision,
 * appends the source_set_revised chain event and marks all affected
 * settled claims for Nachprüfung in the same transaction.
 */
export async function reviseSource(
  input: ReviseSourceInput,
  deps: CaptureDependencies & { runner?: JobRunner } = {},
): Promise<ReviseSourceResult> {
  const fetcher = deps.fetcher ?? nodeHttpFetcher;
  const runner = deps.runner ?? getGlobalJobRunner();
  if (runner.isRunning(input.projectId)) {
    // A verification/relevance run caches the source snapshots at run start
    // (sourcesById); a mid-run revision would let the run silently validate
    // claims against the superseded text — exactly what the revision exists
    // to prevent. Same guard as the config edit.
    throw new RunActiveError(input.projectId);
  }
  const store = requireProjectStore(input.projectId);
  const register = await store.read();
  const source = register.sources.find(
    (candidate) => candidate.id === input.sourceId,
  );
  if (!source) {
    throw new UnknownSourceError(input.sourceId);
  }
  const currentSnapshot = source.custom.snapshot;
  if (!currentSnapshot) {
    throw new SourceRevisionPreconditionError(
      `Quelle "${input.sourceId}" hat keinen Snapshot – ` +
        "ohne eingefrorenen Stand gibt es nichts zu revidieren.",
    );
  }

  // Network/parsing work strictly outside any transaction.
  const document = await acquireDocument(
    { upload: input.upload, documentUrl: input.documentUrl },
    fetcher,
  );
  const blob = store.blobs().put(document.content, document.ext);
  if (blob.sha256 === currentSnapshot.sha256) {
    // Identical content: recognized via checksum, deliberately a total
    // no-op — no revision bump, no event, no recheck. (The put() above was
    // a dedup no-op on the content-addressed store.)
    return { revised: false, recheckedClaimIds: [] };
  }
  const extraction = await extractTextOrError(document.content, document.ext);
  const now = new Date().toISOString();

  return store.transaction((tx) => {
    // TOCTOU re-checks under the lock, mirroring captureSource.
    const lockedSource = tx
      .listSources()
      .find((candidate) => candidate.id === input.sourceId);
    const lockedSnapshot = lockedSource?.custom.snapshot;
    if (!lockedSource || !lockedSnapshot) {
      throw new UnknownSourceError(input.sourceId);
    }
    if (blob.sha256 === lockedSnapshot.sha256) {
      return { revised: false, recheckedClaimIds: [] };
    }
    const newRevision = lockedSnapshot.revision + 1;
    tx.reviseSource(
      input.sourceId,
      buildSnapshot(store.blobs(), blob, extraction, newRevision, now),
    );
    const projectRevision = tx.getProject().source_set_revision;

    const affected = tx
      .listClaims()
      .filter(
        (claim) =>
          RECHECK_STATUSES.has(claim.status) &&
          claim.evidence.some(
            (evidence) => evidence.source_id === input.sourceId,
          ),
      );
    for (const claim of affected) {
      tx.transitionClaim(claim.id, {
        to: "recheck_required",
        actor: "system:source_revision",
        reason:
          `Bestandsrevision der Quelle ${input.sourceId} ` +
          `(Snapshot-Revision ${lockedSnapshot.revision} → ${newRevision}): ` +
          "bisherige Prüfung bezog sich auf die alte Fassung.",
        at: now,
      });
    }
    tx.recordProjectEvent({
      event: "source_set_revised",
      reason:
        `Quelle ${input.sourceId} revidiert: Snapshot-Revision ` +
        `${lockedSnapshot.revision} → ${newRevision} ` +
        `(sha256 ${lockedSnapshot.sha256.slice(0, 12)}… → ${blob.sha256.slice(0, 12)}…), ` +
        `Quellenbestand-Revision ${projectRevision}; ` +
        `${affected.length} Claim(s) zur Nachprüfung markiert.`,
      actor: getCurrentActor(),
      at: now,
    });
    return {
      revised: true,
      newRevision,
      recheckedClaimIds: affected.map((claim) => claim.id),
    };
  });
}
