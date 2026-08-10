import { PipelineError } from "../../errors";
import { requireProjectStore } from "../../projects";
import { buildCandidateReview } from "./review";
import type { ReviewCandidate } from "./review";
import { ReferenceScanResult } from "./schema";

/**
 * Read-side accessor of the reference scan (reference auto-import): follows
 * the `project.reference_scan` pointer, loads and safe-parses its blob (the
 * pipeline-owned shape validated on write by run-reference-scan.ts), and
 * projects it through buildCandidateReview against the CURRENT source list.
 * No scan yet → an empty list, not an error (mirrors getBriefing's "null
 * before import" discipline).
 */
export async function getReferenceCandidates(
  projectId: string,
): Promise<ReviewCandidate[]> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const pointer = register.project.reference_scan;
  if (!pointer) {
    return [];
  }

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

  return buildCandidateReview(parsed.data, register.sources);
}
