import { requireProjectStore } from "../../projects";
import { loadReferenceScanResult } from "./load-scan-result";
import { buildCandidateReview } from "./review";
import type { ReviewCandidate } from "./review";

/**
 * Read-side accessor of the reference scan (reference auto-import): follows
 * the `project.reference_scan` pointer, loads and validates its blob via
 * loadReferenceScanResult (shared with run-reference-capture.ts's per-item
 * re-read, so both readers fail the same German-language way on a corrupt
 * blob), and projects it through buildCandidateReview against the CURRENT
 * source list. No scan yet → an empty list, not an error (mirrors
 * getBriefing's "null before import" discipline).
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

  const result = loadReferenceScanResult(store, pointer);
  return buildCandidateReview(result, register.sources);
}
