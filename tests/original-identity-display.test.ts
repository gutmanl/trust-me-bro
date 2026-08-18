import { describe, expect, it } from "vitest";

import {
  AUTO_CAPTURE_METHOD_LABELS,
  originalCaptureProvenanceLabel,
} from "../app/projects/[id]/auto-capture-labels";
import { buildOriginalIdentityRow } from "../app/projects/[id]/original-identity-vm";
import type { OriginalIdentityVM } from "../lib/pipeline";

/**
 * The display half of the original-identity block.
 *
 * The projection in `lib/pipeline/sources/original-identity.ts` is covered by
 * its own suite and by the coverage ratchet. This file covers the half the user
 * actually reads — which date is labelled, how the capture provenance is
 * phrased, when the block appears at all — because the ratchet is scoped to
 * `lib/**` and `cli/**`, so nothing under `app/**` is visible to it. Four
 * findings of this phase's first code review lived entirely in that gap.
 *
 * What this does NOT cover: the JSX itself (`SourceRow` is a client component
 * behind the `useStartGate` context, so a plain SSR assertion is not available
 * here). The rendered branch that remains unpinned is the `rawText` paragraph;
 * everything that decides ITS input is pinned below.
 */

const PROJECTED: OriginalIdentityVM = {
  citation: "Mayer (2024), ACM TOSEM",
  capturedAt: "2026-07-20T09:00:00Z",
};

describe("buildOriginalIdentityRow", () => {
  it("contributes nothing for a source whose identity was never corrected", () => {
    // The no-regression guarantee, at the display tier: an uncorrected source's
    // row must render exactly as it did before this block existed, so the
    // property is absent rather than present-and-empty.
    const fragment = buildOriginalIdentityRow(undefined);
    expect(fragment).toEqual({});
    expect(Object.hasOwn(fragment, "originalIdentity")).toBe(false);
  });

  it("labels the ORIGINAL capture time in de-DE / Europe/Berlin", () => {
    const row = buildOriginalIdentityRow(PROJECTED).originalIdentity;
    expect(row?.citation).toBe("Mayer (2024), ACM TOSEM");
    // de-DE / Europe/Berlin, per the project's formatting rule: 09:00 UTC in
    // July is 11:00 Berlin, so the row states the user's wall clock rather than
    // the register's UTC, and never the raw ISO string.
    expect(row?.capturedAtLabel).toBe("20.07.2026, 11:00");
    expect(row?.capturedAtLabel).not.toContain("T09:00");
  });

  it("says a source was captured by hand when it never went through auto-import", () => {
    expect(
      buildOriginalIdentityRow(PROJECTED).originalIdentity?.provenanceLabel,
    ).toBe("manuell erfasst");
    // No raw reference text exists for a hand-described source, so the row has
    // nothing to quote rather than an empty pair of quotation marks.
    expect(
      Object.hasOwn(
        buildOriginalIdentityRow(PROJECTED).originalIdentity as object,
        "rawText",
      ),
    ).toBe(false);
  });

  it("carries the original title through to the row", () => {
    const title =
      "Computational alignment of goals and scenarios for complex systems";
    const row = buildOriginalIdentityRow({
      ...PROJECTED,
      title,
    }).originalIdentity;
    // Verbatim and untranslated: this is the source's own title, not UI copy,
    // so the German display tier does not touch it.
    expect(row?.title).toBe(title);
  });

  it("leaves the title property absent when the projection found no distinct title", () => {
    const row = buildOriginalIdentityRow(PROJECTED).originalIdentity;
    // Absent, not present-and-empty: the row renders the line on the property
    // being defined, so an empty string would put a blank line in the block.
    expect(Object.hasOwn(row as object, "title")).toBe(false);
  });

  it("carries the raw reference text of an auto-imported source through", () => {
    const raw = "Mayer, A. (2024): „Effects of AI Assistants“, ACM TOSEM.";
    const row = buildOriginalIdentityRow({
      ...PROJECTED,
      autoCapture: { method: "doi", rawText: raw },
    }).originalIdentity;
    expect(row?.rawText).toBe(raw);
    expect(row?.provenanceLabel).toBe(
      "automatisch übernommen (DOI im Text gefunden)",
    );
  });
});

describe("originalCaptureProvenanceLabel", () => {
  it("names the channel for every method the schema allows", () => {
    for (const method of ["doi", "arxiv", "url", "crossref_title"] as const) {
      expect(originalCaptureProvenanceLabel(method)).toBe(
        `automatisch übernommen (${AUTO_CAPTURE_METHOD_LABELS[method]})`,
      );
    }
  });

  /**
   * `unresolved` means the scan found the citation textually but could pin NO
   * identifier, and the user completed the capture by hand — uploading a PDF or
   * giving a URL (schema comment on `AutoCaptureProvenance.method`). Filing that
   * under "automatisch übernommen" produced the self-contradicting "automatisch
   * übernommen (textuell gefunden, manuell vervollständigt)" and put a
   * hand-completed source on the automatic side of a two-way binary that has
   * three cases (code review WR-04).
   */
  it("does not claim an unresolved capture was taken over automatically", () => {
    const label = originalCaptureProvenanceLabel("unresolved");
    expect(label).toBe("textuell gefunden, manuell vervollständigt");
    expect(label).not.toContain("automatisch");
    // Still the map's existing wording verbatim — the fix removes a false
    // claim, it does not invent new German.
    expect(label).toBe(AUTO_CAPTURE_METHOD_LABELS.unresolved);
  });

  it("distinguishes a guessed identifier from one found verbatim", () => {
    // A crossref_title match resolved a REAL DOI, but by title similarity
    // rather than from the text — a reader must be able to tell those apart.
    expect(originalCaptureProvenanceLabel("crossref_title")).not.toBe(
      originalCaptureProvenanceLabel("doi"),
    );
  });
});
