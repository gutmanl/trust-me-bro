import { randomUUID } from "node:crypto";

import type { ClaimsRegister, SourceType } from "../../../register";
import type { CaptureFailureInput } from "../../../register/schema/history";
import {
  InvalidSourceInputError,
  PipelineError,
  SourceCorrectionPreconditionError,
  UnknownSourceError,
} from "../../errors";
import { requireProjectStore } from "../../projects";
import type { CaptureChainAccess } from "../../runs/auto-chain";
import {
  activeCaptureItem,
  enqueueSourceCapture,
  hasCaptureInFlight,
  pendingCaptureItems,
  removeQueuedCapture as removeQueuedCaptureFromChain,
} from "../../runs/auto-chain";
import type { CaptureKind } from "../capture";
import type { ManualMetadata } from "../csl";
import { extFromFilename } from "../document";
import { isHttpUrl, normalizeArxivId, normalizeDoi } from "../identifiers";
import {
  deriveInterruptedCaptureAttempts,
  deriveOpenCaptureFailures,
} from "./failures";
import type {
  SourceCaptureRequest,
  SourceCaptureWorkItem,
  SourceWorkItemVM,
} from "./types";

/** What the manual capture modal submits: the same shape the synchronous
 * capture form used to send, minus the project id repetition. */
export interface ManualCaptureInput {
  kind: CaptureKind;
  sourceType: SourceType;
  identifier?: string;
  documentUrl?: string;
  manual?: ManualMetadata;
  upload?: { content: Buffer; filename: string };
  /** An upload that is ALREADY frozen in the blob store — the confirm half
   * of the derive→confirm correction wizard (D-15). The derive step froze
   * the bytes to answer "what document is this?", so the confirm submit
   * sends a reference instead of the file again. Takes precedence over
   * `upload`; see freezeUpload. */
  uploadBlob?: { blob_path: string; filename: string };
}

/** Injectable chain accessors, for tests; production uses the globals. */
export interface WorkItemQueueDependencies {
  chain?: CaptureChainAccess;
}

/**
 * The synchronous half of the old capture form's validation: identifier and
 * metadata mistakes a user should see IMMEDIATELY in the modal, before it
 * closes — everything here is pure input inspection. Network truths (does
 * the DOI resolve, is the document a real PDF) stay with the asynchronous
 * attempt and surface as the work item's failure state.
 */
function validateManualInput(
  input: Omit<ManualCaptureInput, "sourceType">,
): void {
  switch (input.kind) {
    case "doi":
      if (!normalizeDoi(input.identifier ?? "")) {
        throw new InvalidSourceInputError(
          `"${input.identifier ?? ""}" ist keine erkennbare DOI.`,
        );
      }
      break;
    case "arxiv":
      if (!normalizeArxivId(input.identifier ?? "")) {
        throw new InvalidSourceInputError(
          `"${input.identifier ?? ""}" ist keine erkennbare arXiv-Id.`,
        );
      }
      break;
    case "url":
      if (!isHttpUrl((input.identifier ?? "").trim())) {
        throw new InvalidSourceInputError(
          `"${input.identifier ?? ""}" ist keine http(s)-URL.`,
        );
      }
      break;
    case "upload":
      break;
  }
  if (
    (input.kind === "url" || input.kind === "upload") &&
    (input.manual?.title ?? "").trim().length === 0
  ) {
    throw new InvalidSourceInputError(
      "Für URL- und Datei-Quellen ist mindestens ein Titel erforderlich.",
    );
  }
}

function displayLabel(input: {
  manual?: ManualMetadata;
  identifier?: string;
  uploadFilename?: string;
  kind: CaptureKind;
}): string {
  return (
    input.manual?.title?.trim() ||
    input.identifier?.trim() ||
    input.uploadFilename ||
    input.kind
  );
}

/**
 * Validates a blob reference the BROWSER supplied (threat T-l0f-01).
 *
 * Traversal is already ruled out by `BlobPath` inside `resolveBlobPath`,
 * and the project id comes from the route, so the reachable set is this
 * project's own blobs — but `resolveBlobPath` signals a mismatch with a
 * plain `Error`, and a plain Error is a PROGRAMMING error to
 * `runPipelineAction`: it would escape the server action unhandled instead
 * of rendering the German banner every other bad input renders. Both a
 * throw and an honest `false` therefore become an `InvalidSourceInputError`
 * here, before the reference is trusted anywhere downstream.
 *
 * The filename is checked with the same seriousness because it is
 * load-bearing rather than decorative: `toCaptureSourceInput` hands it to
 * `acquireDocument`, which re-derives the document's extension from it via
 * `extFromFilename` — so the filename decides whether the bytes meet the
 * `%PDF-` signature check.
 */
function assertFrozenUpload(
  store: ReturnType<typeof requireProjectStore>,
  uploadBlob: { blob_path: string; filename: string },
): { blob_path: string; filename: string } {
  const filename = uploadBlob.filename.trim();
  if (filename.length === 0 || /[/\\]/.test(filename)) {
    throw new InvalidSourceInputError(
      "Der Dateiname des vorbereiteten Dokuments ist ungültig – " +
        "bitte das Dokument erneut hochladen.",
    );
  }
  let exists: boolean;
  try {
    exists = store.blobs().exists(uploadBlob.blob_path);
  } catch {
    exists = false;
  }
  if (!exists) {
    throw new InvalidSourceInputError(
      "Das vorbereitete Dokument ist nicht mehr auffindbar – " +
        "bitte das Dokument erneut hochladen.",
    );
  }
  return { blob_path: uploadBlob.blob_path, filename };
}

/**
 * Freezes an uploaded document into the blob store so the queue never
 * holds bytes, and enforces that an upload-kind input actually carries
 * one — the shared front half of every enqueue path.
 */
function freezeUpload(
  store: ReturnType<typeof requireProjectStore>,
  input: Omit<ManualCaptureInput, "sourceType">,
): { blob_path: string; filename: string } | undefined {
  // Already frozen by the derive step (D-15): reuse the reference and put
  // NOTHING, so the bytes travel from the browser exactly once. The
  // `kind === "upload"` requirement below is satisfied by construction on
  // this path — a pre-frozen reference IS the document it asks for.
  if (input.uploadBlob !== undefined) {
    return assertFrozenUpload(store, input.uploadBlob);
  }
  let uploadBlob: { blob_path: string; filename: string } | undefined;
  if (input.upload !== undefined) {
    const blob = store
      .blobs()
      .put(input.upload.content, extFromFilename(input.upload.filename));
    uploadBlob = { blob_path: blob.blobPath, filename: input.upload.filename };
  }
  if (input.kind === "upload" && uploadBlob === undefined) {
    throw new InvalidSourceInputError(
      "Für eine Datei-Quelle muss ein Dokument hochgeladen werden.",
    );
  }
  return uploadBlob;
}

/** Builds the queued request from a validated input and its frozen upload
 * — shared by the manual and the correction enqueue so the two shapes can
 * never drift. */
function buildRequest(
  input: Omit<ManualCaptureInput, "sourceType">,
  sourceType: SourceType,
  uploadBlob: { blob_path: string; filename: string } | undefined,
  targetSourceId?: string,
): SourceCaptureRequest {
  return {
    kind: input.kind,
    sourceType,
    ...(targetSourceId !== undefined ? { targetSourceId } : {}),
    ...(input.identifier !== undefined ? { identifier: input.identifier } : {}),
    ...(input.documentUrl !== undefined
      ? { documentUrl: input.documentUrl }
      : {}),
    ...(input.manual !== undefined ? { manual: input.manual } : {}),
    ...(uploadBlob !== undefined ? { uploadBlob } : {}),
  };
}

/**
 * Queues one manual capture (source work items): validates the pure input
 * half synchronously, freezes an uploaded document into the blob store so
 * the queue never holds bytes, and pushes the work item onto the project's
 * auto-chain. Returns immediately — progress and outcome arrive through the
 * shared event stream and the durable failure derivation. Retrying a
 * failed item is `retryManualCapture`'s job, from the durable snapshot.
 */
export async function enqueueManualCapture(
  projectId: string,
  input: ManualCaptureInput,
  options: WorkItemQueueDependencies = {},
): Promise<{ workItemId: string }> {
  const store = requireProjectStore(projectId);
  validateManualInput(input);

  const uploadBlob = freezeUpload(store, input);
  const request = buildRequest(input, input.sourceType, uploadBlob);

  const item: SourceCaptureWorkItem = {
    workItemId: `wi_${randomUUID()}`,
    origin: "manual",
    label: displayLabel({
      manual: input.manual,
      identifier: input.identifier,
      uploadFilename: input.upload?.filename ?? input.uploadBlob?.filename,
      kind: input.kind,
    }),
    request,
  };
  (options.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(
    projectId,
    item,
  );
  return { workItemId: item.workItemId };
}

/** What the correction section of the source modal submits (source
 * correction): the capture shape minus the mandatory source type — a
 * correction keeps the target's current classification unless the form
 * overrides it. */
export interface SourceCorrectionInput extends Omit<
  ManualCaptureInput,
  "sourceType"
> {
  sourceType?: SourceType;
}

/**
 * Queues one identity correction of an EXISTING source (source correction):
 * validates the corrected identity synchronously, freezes an upload, and
 * pushes a "correction" work item — carrying the target source id — onto
 * the same per-project chain as every capture, so it serializes with all
 * other runs. At most one correction per source may be queued or running:
 * two queued corrections of the same source would race for the same
 * identity slot, and the second submit is virtually always a mistake.
 */
export async function enqueueSourceCorrection(
  projectId: string,
  sourceId: string,
  input: SourceCorrectionInput,
  options: WorkItemQueueDependencies = {},
): Promise<{ workItemId: string }> {
  const store = requireProjectStore(projectId);
  validateManualInput(input);
  const register = await store.read();
  const source = register.sources.find(
    (candidate) => candidate.id === sourceId,
  );
  if (!source) {
    throw new UnknownSourceError(sourceId);
  }
  if (
    hasCaptureInFlight(
      projectId,
      (item) => item.targetSourceId === sourceId,
      options.chain,
    )
  ) {
    throw new SourceCorrectionPreconditionError(
      `Für Quelle "${sourceId}" läuft bereits eine Korrektur – ` +
        "bitte deren Abschluss abwarten.",
    );
  }

  const uploadBlob = freezeUpload(store, input);
  const request = buildRequest(
    input,
    input.sourceType ?? source.custom.source_type,
    uploadBlob,
    sourceId,
  );
  const item: SourceCaptureWorkItem = {
    workItemId: `wi_${randomUUID()}`,
    origin: "correction",
    label: displayLabel({
      manual: input.manual,
      identifier: input.identifier,
      uploadFilename: input.upload?.filename ?? input.uploadBlob?.filename,
      kind: input.kind,
    }),
    request,
  };
  (options.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(
    projectId,
    item,
  );
  return { workItemId: item.workItemId };
}

/**
 * The unified work-item status list of a project (source work items):
 * capturing first (at most one — the chain is sequential), then the waiting
 * backlog in queue order, then the durable open failures — each exactly
 * once, live state taking precedence over a stale failure of the same item
 * (a running retry must not show as failed).
 */
export function getSourceWorkItems(
  projectId: string,
  register: ClaimsRegister,
  deps: WorkItemQueueDependencies = {},
): SourceWorkItemVM[] {
  const active = (deps.chain?.activeCaptureItem ?? activeCaptureItem)(
    projectId,
  );
  const queued = (deps.chain?.pendingCaptureItems ?? pendingCaptureItems)(
    projectId,
  );
  const rows: SourceWorkItemVM[] = [];
  const seen = new Set<string>();
  if (active) {
    rows.push({ ...active, status: "capturing" });
    seen.add(active.workItemId);
  }
  for (const item of queued) {
    if (!seen.has(item.workItemId)) {
      rows.push({ ...item, status: "queued" });
      seen.add(item.workItemId);
    }
  }
  for (const failure of deriveOpenCaptureFailures(register)) {
    if (seen.has(failure.workItemId)) {
      continue;
    }
    seen.add(failure.workItemId);
    rows.push({
      workItemId: failure.workItemId,
      origin: failure.origin,
      label: displayLabel({
        manual: failure.input.manual,
        identifier: failure.input.identifier,
        uploadFilename: failure.input.upload?.filename,
        kind: failure.input.kind,
      }),
      ...(failure.input.target_source_id !== undefined
        ? { targetSourceId: failure.input.target_source_id }
        : {}),
      status: "failed",
      error: failure.reason,
      failedAt: failure.failedAt,
    });
  }
  // Attempts cut off before any outcome (run visibility): visible and
  // retryable like failures, but the message says what actually happened —
  // nothing was recorded, not "it failed".
  for (const interrupted of deriveInterruptedCaptureAttempts(register)) {
    if (seen.has(interrupted.workItemId)) {
      continue;
    }
    seen.add(interrupted.workItemId);
    rows.push({
      workItemId: interrupted.workItemId,
      origin: interrupted.origin,
      label: displayLabel({
        manual: interrupted.input.manual,
        identifier: interrupted.input.identifier,
        uploadFilename: interrupted.input.upload?.filename,
        kind: interrupted.input.kind,
      }),
      ...(interrupted.input.target_source_id !== undefined
        ? { targetSourceId: interrupted.input.target_source_id }
        : {}),
      status: "interrupted",
      error:
        "Erfassung unterbrochen (Absturz, Abbruch oder Zeitüberschreitung) – " +
        "kein Ergebnis aufgezeichnet.",
      failedAt: interrupted.since,
    });
  }
  return rows;
}

/**
 * Drops a still-WAITING capture work item from the backlog (run visibility:
 * queued work must be removable by the user). False when the item is no
 * longer waiting — already capturing, finished, or never queued — so a
 * stale click is a no-op, never an error.
 */
export function removeQueuedCapture(
  projectId: string,
  workItemId: string,
  deps: WorkItemQueueDependencies = {},
): boolean {
  return (deps.chain?.removeQueuedCapture ?? removeQueuedCaptureFromChain)(
    projectId,
    workItemId,
  );
}

/**
 * Re-queues a failed manual or correction work item from its durable input
 * snapshot, as recorded — the one-click retry, re-using the same work-item
 * id so the eventual success resolves the recorded failure. A frozen
 * upload rides along by blob reference; nothing is re-uploaded.
 * Reference-import failures are excluded: their retry path is the
 * candidate review, whose per-row form can also fix the inputs.
 */
export async function retryManualCapture(
  projectId: string,
  workItemId: string,
  deps: WorkItemQueueDependencies = {},
): Promise<{ workItemId: string }> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const failure = deriveOpenCaptureFailures(register).find(
    (candidate) =>
      candidate.workItemId === workItemId &&
      (candidate.origin === "manual" ||
        candidate.origin === "correction" ||
        candidate.origin === "auto_repair"),
  );
  if (!failure) {
    throw new PipelineError(
      `Zum Arbeitsposten "${workItemId}" liegt kein offener Fehlschlag vor.`,
    );
  }
  const item = itemFromDurableInput(workItemId, failure.origin, failure.input);
  (deps.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(projectId, item);
  return { workItemId };
}

/** Rebuilds a work item from a durable input snapshot — the shared back
 * half of retrying a recorded failure and retrying an INTERRUPTED attempt
 * (run visibility), so the two rebuilds can never drift. */
function itemFromDurableInput(
  workItemId: string,
  origin: SourceCaptureWorkItem["origin"],
  input: CaptureFailureInput,
): SourceCaptureWorkItem {
  const request: SourceCaptureRequest = {
    kind: input.kind,
    sourceType: input.source_type,
    ...(input.target_source_id !== undefined
      ? { targetSourceId: input.target_source_id }
      : {}),
    ...(input.identifier !== undefined ? { identifier: input.identifier } : {}),
    ...(input.document_url !== undefined
      ? { documentUrl: input.document_url }
      : {}),
    ...(input.manual !== undefined ? { manual: input.manual } : {}),
    ...(input.upload !== undefined
      ? {
          uploadBlob: {
            blob_path: input.upload.blob_path,
            filename: input.upload.filename,
          },
        }
      : {}),
    // Auto-import provenance rides along (automatic repair): the retry is
    // a fresh attempt whose OWN failure is recorded from this request, so
    // dropping the raw citation line here would quietly cost the repair
    // evaluator the context it re-resolves from.
    ...(input.auto_capture !== undefined
      ? { autoCapture: { ...input.auto_capture } }
      : {}),
  };
  return {
    workItemId,
    origin,
    label: displayLabel({
      manual: input.manual,
      identifier: input.identifier,
      // The DURABLE input (CaptureFailureInput, a strictObject) carries a
      // frozen upload under `upload` and has no `uploadBlob` member — the
      // register schema is deliberately untouched by the derive→confirm
      // round trip.
      uploadFilename: input.upload?.filename,
      kind: input.kind,
    }),
    request,
  };
}

/**
 * Re-queues an INTERRUPTED capture attempt (run visibility) from the input
 * its start bracket snapshotted — the attempt that has no failure event to
 * retry from, because a crash, a cancel or an expired deadline cut it off
 * before any outcome. Same work-item id, so the eventual success or failure
 * closes the open bracket's story.
 */
export async function retryInterruptedCapture(
  projectId: string,
  workItemId: string,
  deps: WorkItemQueueDependencies = {},
): Promise<{ workItemId: string }> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const interrupted = deriveInterruptedCaptureAttempts(register).find(
    (candidate) => candidate.workItemId === workItemId,
  );
  if (!interrupted) {
    throw new PipelineError(
      `Zum Arbeitsposten "${workItemId}" liegt keine unterbrochene Erfassung vor.`,
    );
  }
  if (
    hasCaptureInFlight(
      projectId,
      (item) => item.workItemId === workItemId,
      deps.chain,
    )
  ) {
    // Already queued or running again — a double-click, not an error.
    return { workItemId };
  }
  const item = itemFromDurableInput(
    workItemId,
    interrupted.origin,
    interrupted.input,
  );
  (deps.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(projectId, item);
  return { workItemId };
}
