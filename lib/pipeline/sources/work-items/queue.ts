import { randomUUID } from "node:crypto";

import type { ClaimsRegister, SourceType } from "../../../register";
import { InvalidSourceInputError, PipelineError } from "../../errors";
import { requireProjectStore } from "../../projects";
import type { AutoChain } from "../../runs/auto-chain";
import {
  activeCaptureItem,
  enqueueSourceCapture,
  pendingCaptureItems,
} from "../../runs/auto-chain";
import type { CaptureKind } from "../capture";
import type { ManualMetadata } from "../csl";
import { extFromFilename } from "../document";
import { isHttpUrl, normalizeArxivId, normalizeDoi } from "../identifiers";
import { deriveOpenCaptureFailures } from "./failures";
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
}

/** Injectable chain accessors, for tests; production uses the globals. */
export interface WorkItemQueueDependencies {
  chain?: Pick<
    AutoChain,
    "enqueueSourceCapture" | "pendingCaptureItems" | "activeCaptureItem"
  >;
}

/**
 * The synchronous half of the old capture form's validation: identifier and
 * metadata mistakes a user should see IMMEDIATELY in the modal, before it
 * closes — everything here is pure input inspection. Network truths (does
 * the DOI resolve, is the document a real PDF) stay with the asynchronous
 * attempt and surface as the work item's failure state.
 */
function validateManualInput(input: ManualCaptureInput): void {
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
 * Queues one manual capture (source work items): validates the pure input
 * half synchronously, freezes an uploaded document into the blob store so
 * the queue never holds bytes, and pushes the work item onto the project's
 * auto-chain. Returns immediately — progress and outcome arrive through the
 * shared event stream and the durable failure derivation.
 *
 * `retryOf` re-submits a failed work item under its OWN id, which is what
 * lets the eventual success resolve the recorded failure; a retry without a
 * fresh upload reuses the frozen blob of the failed attempt.
 */
export async function enqueueManualCapture(
  projectId: string,
  input: ManualCaptureInput,
  options: { retryOf?: string } & WorkItemQueueDependencies = {},
): Promise<{ workItemId: string }> {
  const store = requireProjectStore(projectId);
  validateManualInput(input);

  let uploadBlob: { blob_path: string; filename: string } | undefined;
  if (input.upload !== undefined) {
    const blob = store
      .blobs()
      .put(input.upload.content, extFromFilename(input.upload.filename));
    uploadBlob = { blob_path: blob.blobPath, filename: input.upload.filename };
  } else if (options.retryOf !== undefined && input.kind === "upload") {
    // A retry that did not re-upload keeps the failed attempt's frozen
    // document — that is the point of freezing it at enqueue time.
    const register = await store.read();
    const failure = deriveOpenCaptureFailures(register).find(
      (candidate) =>
        candidate.workItemId === options.retryOf &&
        candidate.origin === "manual",
    );
    if (failure?.input.upload !== undefined) {
      uploadBlob = { ...failure.input.upload };
    }
  }
  if (input.kind === "upload" && uploadBlob === undefined) {
    // Checked here rather than in validateManualInput: a retry of a failed
    // upload legitimately arrives without fresh bytes and reuses the frozen
    // blob resolved just above.
    throw new InvalidSourceInputError(
      "Für eine Datei-Quelle muss ein Dokument hochgeladen werden.",
    );
  }

  const request: SourceCaptureRequest = {
    kind: input.kind,
    sourceType: input.sourceType,
    ...(input.identifier !== undefined
      ? { identifier: input.identifier }
      : {}),
    ...(input.documentUrl !== undefined
      ? { documentUrl: input.documentUrl }
      : {}),
    ...(input.manual !== undefined ? { manual: input.manual } : {}),
    ...(uploadBlob !== undefined ? { uploadBlob } : {}),
  };

  const workItemId = options.retryOf ?? `wi_${randomUUID()}`;
  const item: SourceCaptureWorkItem = {
    workItemId,
    origin: "manual",
    label: displayLabel({
      manual: input.manual,
      identifier: input.identifier,
      uploadFilename: input.upload?.filename ?? uploadBlob?.filename,
      kind: input.kind,
    }),
    request,
  };
  (options.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(
    projectId,
    item,
  );
  return { workItemId };
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
    rows.push({
      workItemId: failure.workItemId,
      origin: failure.origin,
      label: displayLabel({
        manual: failure.input.manual,
        identifier: failure.input.identifier,
        uploadFilename: failure.input.upload?.filename,
        kind: failure.input.kind,
      }),
      status: "failed",
      error: failure.reason,
      failedAt: failure.failedAt,
      ...(failure.origin === "manual" ? { retryInput: failure.input } : {}),
    });
  }
  return rows;
}

/**
 * Re-queues a failed manual work item from its durable input snapshot, as
 * recorded — the one-click retry. The modal-based retry path (adjusting the
 * input first) goes through `enqueueManualCapture` with `retryOf` instead.
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
      candidate.workItemId === workItemId && candidate.origin === "manual",
  );
  if (!failure) {
    throw new PipelineError(
      `Zum Arbeitsposten "${workItemId}" liegt kein offener Fehlschlag vor.`,
    );
  }
  const input = failure.input;
  const request: SourceCaptureRequest = {
    kind: input.kind,
    sourceType: input.source_type,
    ...(input.identifier !== undefined
      ? { identifier: input.identifier }
      : {}),
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
  };
  const item: SourceCaptureWorkItem = {
    workItemId,
    origin: "manual",
    label: displayLabel({
      manual: input.manual,
      identifier: input.identifier,
      uploadFilename: input.upload?.filename,
      kind: input.kind,
    }),
    request,
  };
  (deps.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(projectId, item);
  return { workItemId };
}
