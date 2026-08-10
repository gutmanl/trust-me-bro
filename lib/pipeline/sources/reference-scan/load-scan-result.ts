import type { RegisterStore } from "../../../register";
import { PipelineError } from "../../errors";
import { ReferenceScanResult } from "./schema";

/**
 * Shared "read + validate the scan blob" logic (reference auto-import):
 * BOTH readers of a reference-scan pointer — the review projection
 * (read-candidates.ts) and the capture batch's per-item, current-blob
 * re-read (run-reference-capture.ts) — go through this ONE function, so a
 * corrupt or truncated blob always surfaces the same German
 * `PipelineError`, never a raw JSON.parse SyntaxError or a ZodError. Kept
 * off the pipeline barrel: only the two in-cluster call sites use it.
 */
export function loadReferenceScanResult(
  store: RegisterStore,
  pointer: { blob_path: string },
): ReferenceScanResult {
  let raw: unknown;
  try {
    raw = JSON.parse(store.blobs().readText(pointer.blob_path));
  } catch (error) {
    throw new PipelineError(
      `Ergebnis des Referenz-Scans unter "${pointer.blob_path}" ist beschädigt (kein gültiges JSON).`,
      { cause: error },
    );
  }
  const parsed = ReferenceScanResult.safeParse(raw);
  if (!parsed.success) {
    throw new PipelineError(
      `Ergebnis des Referenz-Scans unter "${pointer.blob_path}" ist beschädigt (Schema verletzt).`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
