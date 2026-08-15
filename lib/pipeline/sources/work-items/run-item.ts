import { requireProjectStore } from "../../projects";
import {
  enqueueExistenceCheck,
  enqueueSourceExtraction,
} from "../../runs/auto-chain";
import { getGlobalJobRunner } from "../../runs/job-runner";
import type { JobRunner } from "../../runs/job-runner";
import type { RunHandle } from "../../runs/types";
import { captureSource } from "../capture";
import type { CaptureSourceInput } from "../capture";
import { correctSource } from "../correction";
import type { HttpFetcher } from "../fetch-port";
import { recordCaptureFailure } from "./failures";
import type { SourceCaptureRequest, SourceCaptureWorkItem } from "./types";

export interface SourceCaptureItemResult {
  workItemId: string;
  sourceId: string;
  message: string;
}

export interface SourceCaptureItemDependencies {
  runner?: JobRunner;
  fetcher?: HttpFetcher;
}

/** Rebuilds the low-level capture input from a queued request, reading a
 * frozen upload's bytes back from the blob store. */
export function toCaptureSourceInput(
  projectId: string,
  workItemId: string,
  request: SourceCaptureRequest,
): CaptureSourceInput {
  const input: CaptureSourceInput = {
    projectId,
    kind: request.kind,
    sourceType: request.sourceType,
    captureAttemptId: workItemId,
  };
  if (request.identifier !== undefined) {
    input.identifier = request.identifier;
  }
  if (request.documentUrl !== undefined) {
    input.documentUrl = request.documentUrl;
  }
  if (request.expectedExt !== undefined) {
    input.expectedExt = request.expectedExt;
  }
  if (request.manual !== undefined) {
    input.manual = request.manual;
  }
  if (request.autoCapture !== undefined) {
    input.autoCapture = request.autoCapture;
  }
  if (request.uploadBlob !== undefined) {
    const store = requireProjectStore(projectId);
    input.upload = {
      content: store.blobs().read(request.uploadBlob.blob_path),
      filename: request.uploadBlob.filename,
    };
  }
  return input;
}

/**
 * Runs one capture work item as its own single-item job-runner run of kind
 * "source_capture" (source work items). Success commits the source (stamped
 * with the work-item id) and auto-chains its extraction pass — the same
 * per-item chaining the reference capture batch established. Failure records
 * the durable `source_capture_failed` event, then rethrows so the runner's
 * own item outcome drives the live feed exactly like every other run kind.
 */
export async function startSourceCaptureItem(
  projectId: string,
  item: SourceCaptureWorkItem,
  deps: SourceCaptureItemDependencies = {},
): Promise<RunHandle<SourceCaptureItemResult>> {
  const runner = deps.runner ?? getGlobalJobRunner();
  const fetcher = deps.fetcher;
  return runner.submit(
    projectId,
    [item],
    (workItem) => workItem.workItemId,
    (workItem) => captureWorkItem(projectId, workItem, fetcher),
    { kind: "source_capture" },
  );
}

/** The live (or latest) source-capture run handle, for the SSE stream and
 * the server-rendered "capturing" state. */
export function getSourceCaptureRun(
  projectId: string,
  deps: { runner?: JobRunner } = {},
): RunHandle | undefined {
  return (deps.runner ?? getGlobalJobRunner()).currentRun(
    projectId,
    "source_capture",
  );
}

async function captureWorkItem(
  projectId: string,
  item: SourceCaptureWorkItem,
  fetcher: HttpFetcher | undefined,
): Promise<SourceCaptureItemResult> {
  const input = toCaptureSourceInput(projectId, item.workItemId, item.request);
  try {
    if (item.request.targetSourceId !== undefined) {
      // Correction item (source correction): replace the target's identity
      // instead of creating a source. Its claims keep their evidence, so
      // nothing new is extracted — but the readmitted claims need stage 1
      // against the corrected identity/document.
      const result = await correctSource(
        {
          projectId,
          sourceId: item.request.targetSourceId,
          kind: input.kind,
          correctionAttemptId: item.workItemId,
          ...(input.identifier !== undefined
            ? { identifier: input.identifier }
            : {}),
          ...(input.documentUrl !== undefined
            ? { documentUrl: input.documentUrl }
            : {}),
          // Same corpus-integrity guard as a capture: a correction freezes
          // a document too, and an auto-derived URL that turns out to serve
          // a landing page must fail the attempt, not enter the corpus.
          ...(input.expectedExt !== undefined
            ? { expectedExt: input.expectedExt }
            : {}),
          ...(input.manual !== undefined ? { manual: input.manual } : {}),
          ...(input.upload !== undefined ? { upload: input.upload } : {}),
          sourceType: input.sourceType,
        },
        { fetcher },
      );
      if (result.recheckedClaimIds.length > 0) {
        enqueueExistenceCheck(projectId);
      }
      return {
        workItemId: item.workItemId,
        sourceId: item.request.targetSourceId,
        message:
          `Quellenkennung von "${item.request.targetSourceId}" korrigiert – ` +
          `${result.recheckedClaimIds.length} Claim(s) zur Nachprüfung markiert.`,
      };
    }
    const source = await captureSource(input, { fetcher });
    // Per-item chaining, like the reference capture batch before it: every
    // successful capture is followed by its own extraction pass, without
    // every caller having to remember it.
    enqueueSourceExtraction(projectId, source.id);
    return {
      workItemId: item.workItemId,
      sourceId: source.id,
      message: `Quelle "${source.id}" erfasst.`,
    };
  } catch (error) {
    await recordCaptureFailure(projectId, item, error);
    throw error;
  }
}
