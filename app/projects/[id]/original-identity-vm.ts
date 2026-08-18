import type { OriginalIdentityVM } from "@/lib/pipeline";
import { formatTimestamp } from "../status-labels";
import { originalCaptureProvenanceLabel } from "./auto-capture-labels";

/**
 * Display tier of the original-identity block: turns the pipeline's projection
 * into the display-ready strings the source row renders.
 *
 * A separate module rather than four lines inside the page's `flatMap` because
 * this is where the block's German copy is decided — which date is labelled,
 * how the capture provenance is phrased, whether the block appears at all — and
 * the coverage ratchet is scoped to `lib/**` and `cli/**`, so anything left in
 * `page.tsx` is unreachable by any test. Four defects of the first code review
 * of this phase lived in exactly that gap.
 */

/** The row's original-identity sub-object: display-ready strings only, no
 * register data. Structurally pinned against `SourceRowVM.originalIdentity` by
 * the page's assignment — a drift is a compile error, not a silent mismatch. */
export interface OriginalIdentityRowVM {
  citation: string;
  /** The ORIGINAL item's own title, absent when its citation already is the
   * title. The source's own words, so no German is decided for it here. */
  title?: string;
  capturedAtLabel: string;
  provenanceLabel: string;
  rawText?: string;
}

/**
 * The `originalIdentity` property of a source row, as a spreadable fragment:
 * `{}` when the source's identity was never corrected (or carries no archived
 * snapshot to date the original by), so the row renders exactly as it did
 * before this block existed.
 */
export function buildOriginalIdentityRow(
  projected: OriginalIdentityVM | undefined,
): { originalIdentity?: OriginalIdentityRowVM } {
  if (projected === undefined) {
    return {};
  }
  const auto = projected.autoCapture;
  return {
    originalIdentity: {
      citation: projected.citation,
      // Passed through verbatim and untranslated: it is the source's own
      // title, not UI copy. Absent rather than empty when the projection found
      // no distinct title, so the row has nothing to render instead of an
      // empty line.
      ...(projected.title !== undefined ? { title: projected.title } : {}),
      // The ORIGINAL capture time — the row's own "Stand" date is the current
      // snapshot's, which on a corrected source is the correction's.
      capturedAtLabel: formatTimestamp(projected.capturedAt),
      provenanceLabel: originalCaptureProvenanceLabel(auto?.method),
      // Only an auto-imported source has a raw reference text; for a manually
      // described one the property is absent rather than empty, so the row has
      // nothing to render instead of an empty pair of quotation marks.
      ...(auto !== undefined ? { rawText: auto.rawText } : {}),
    },
  };
}
