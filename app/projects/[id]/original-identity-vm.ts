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

/**
 * The row's original-identity sub-object: display-ready strings only, no
 * register data crosses into the client component.
 *
 * The SINGLE declaration of this shape. `SourceRowVM.originalIdentity` refers
 * to this type rather than restating it, so a field added here reaches the row
 * VM and the component's props by construction and cannot be silently dropped
 * at the page's assignment. That is pinned inside `npm run typecheck` by the
 * mutual-assignability case in `workbench/SourceRow.test.tsx`.
 *
 * Two hops on this path are NOT type-checked, and no comment here may claim
 * otherwise (WR-03 is what happens when one does):
 *
 * 1. `OriginalIdentityVM` → `OriginalIdentityRowVM` is a hand-written copy
 *    inside `buildOriginalIdentityRow` below, so a field added to the pipeline
 *    projection and not threaded through here is a silent no-op.
 *    Covered by `tests/original-identity-display.test.ts`.
 * 2. A field present on this type but never rendered in the JSX is not a type
 *    error at all. Covered by the content and paragraph-count assertions in
 *    `workbench/SourceRow.test.tsx`.
 */
export interface OriginalIdentityRowVM {
  /** Citation of the first archived identity, formatted server-side through
   * the same code path as the current one so both read identically. */
  citation: string;
  /** The ORIGINAL item's own title. Absent when the archived item names no
   * usable author, because its citation above then already IS the title. The
   * source's own words, so no German is decided for it here. */
  title?: string;
  /** de-DE label of the ORIGINAL capture time. */
  capturedAtLabel: string;
  /** German clause stating how the source was ORIGINALLY captured, composed
   * server-side: the component must not decide it, because "auto-import method
   * present" does not mean "captured automatically" for every method value
   * (see `originalCaptureProvenanceLabel`). */
  provenanceLabel: string;
  /** Raw reference text the auto-import matched, shown in full. */
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
