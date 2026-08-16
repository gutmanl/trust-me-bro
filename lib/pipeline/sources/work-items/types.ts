import type { SourceType } from "../../../register";
import type { ManualMetadata } from "../csl";

/**
 * Source work items (workbench epic): every way a source enters the project
 * — the manual capture modal, a reference-import candidate — becomes one
 * work item on the auto-chain's per-project FIFO, runs as its own
 * single-item job-runner run of kind "source_capture", and reports a
 * per-item status in the unified sources list.
 *
 * The request that travels through the queue deliberately carries NO
 * buffers: an uploaded document is frozen into the project's
 * content-addressed blob store at enqueue time and referenced by path, so
 * a queued upload costs no process memory, survives into the durable
 * failure record, and a retry never needs a re-upload.
 */
export interface SourceCaptureRequest {
  kind: "doi" | "arxiv" | "url" | "upload";
  sourceType: SourceType;
  /** Set ONLY for correction items (source correction): the EXISTING
   * source whose identity this request replaces — the item then runs
   * `correctSource` instead of `captureSource` and never creates a new
   * source. */
  targetSourceId?: string;
  identifier?: string;
  documentUrl?: string;
  /** Corpus-integrity guard for auto-derived document URLs (reference
   * import); manual captures never set it. */
  expectedExt?: string;
  manual?: ManualMetadata;
  /** Uploaded document, already frozen as a blob at enqueue time. */
  uploadBlob?: { blob_path: string; filename: string };
  /** Provenance for captures originating from the reference auto-import
   * flow; absent for manual captures. */
  autoCapture?: {
    raw_text: string;
    method: "doi" | "arxiv" | "url" | "crossref_title" | "unresolved";
    score?: number;
  };
}

/** How a work item entered the queue: the manual capture modal, a
 * reference-import candidate, a correction of an existing source's
 * identity (source correction), or an automatic repair's own attempt
 * (automatic repair — the loop guard keys on this origin). */
export type SourceWorkItemOrigin =
  "manual" | "reference_import" | "correction" | "auto_repair";

/** One queued or running capture work item, as the auto-chain carries it. */
export interface SourceCaptureWorkItem {
  workItemId: string;
  origin: SourceWorkItemOrigin;
  /** Display label of the row while the item is queued/running (the
   * eventual source's citation does not exist yet). */
  label: string;
  request: SourceCaptureRequest;
}

/** Identity + label of a queued/running item, for status displays. */
export interface SourceCaptureItemInfo {
  workItemId: string;
  origin: SourceWorkItemOrigin;
  label: string;
  /** The corrected source, for correction items — lets the UI render the
   * item's state on that source's own row. */
  targetSourceId?: string;
}

/**
 * One row of the unified work-item status list, combining the volatile
 * queue/runner state (queued, capturing) with the durable failure events
 * (failed). Successful items never appear here — the captured source entry
 * itself is their row.
 */
export interface SourceWorkItemVM {
  workItemId: string;
  origin: SourceWorkItemOrigin;
  label: string;
  /** The corrected source, for correction items — such rows render on that
   * source's own row instead of as standalone list entries. */
  targetSourceId?: string;
  /** "interrupted": a start bracket with no outcome — the attempt was cut
   * off by a crash, a cancel or an expired deadline before it could even
   * record its failure (run visibility); retryable from the bracket's
   * input snapshot exactly like a failed row. */
  status: "queued" | "capturing" | "failed" | "interrupted";
  /** German failure reason; present when status is "failed". */
  error?: string;
  /** ISO timestamp of the recorded failure; present when status is
   * "failed". */
  failedAt?: string;
}
