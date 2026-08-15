import { describe, expect, it } from "vitest";

import type { Source } from "../../../register";
import {
  citationMetaFromManual,
  citationMetaFromSource,
  repairableOrigin,
} from "./repair-input";

function sourceOf(fields: Record<string, unknown>): Source {
  return {
    id: "src_x",
    type: "article-journal",
    custom: { source_type: "peer_reviewed_publication" },
    ...fields,
  } as unknown as Source;
}

describe("repairableOrigin", () => {
  it.each(["manual", "reference_import", "correction"] as const)(
    "admits %s — every way a human or the scan starts a capture",
    (origin) => {
      expect(repairableOrigin(origin)).toBe(true);
    },
  );

  it("rejects auto_repair: the repair's own failure is the loop guard", () => {
    expect(repairableOrigin("auto_repair")).toBe(false);
  });
});

describe("citationMetaFromManual", () => {
  it('reorders the form\'s "Nachname, Vorname; …" field so the family name lands last', () => {
    // The matcher scores the first author by taking the LAST word as the
    // family name, so the order here is what makes the author component
    // score at all.
    expect(
      citationMetaFromManual({
        title: "Semantic Chunking",
        authors: "Siegmund, Janet; Peitek, Norman",
        year: "2017",
      }),
    ).toEqual({
      title: "Semantic Chunking",
      authors: ["Janet Siegmund", "Norman Peitek"],
      year: 2017,
    });
  });

  it("keeps a literal single-word name as written", () => {
    expect(
      citationMetaFromManual({ title: "T", authors: "Behavioral Programming" })
        .authors,
    ).toEqual(["Behavioral Programming"]);
  });

  it("omits a year that is not a four-digit number", () => {
    const meta = citationMetaFromManual({ title: "T", year: "im Druck" });
    expect(meta).toEqual({ title: "T", authors: [] });
    expect("year" in meta).toBe(false);
  });

  it("yields an empty author list when the field is absent", () => {
    expect(citationMetaFromManual({ title: "T" }).authors).toEqual([]);
  });
});

describe("citationMetaFromSource", () => {
  it("renders CSL names and the issued year", () => {
    expect(
      citationMetaFromSource(
        sourceOf({
          title: "A Study on Comprehensibility",
          author: [
            { family: "Ashrov", given: "Adiel" },
            { literal: "Behavioral Programming Group" },
          ],
          issued: { "date-parts": [[2025, 3]] },
        }),
      ),
    ).toEqual({
      title: "A Study on Comprehensibility",
      authors: ["Adiel Ashrov", "Behavioral Programming Group"],
      year: 2025,
    });
  });

  it("is undefined without a usable title — an author-only query is noise", () => {
    expect(
      citationMetaFromSource(sourceOf({ author: [{ family: "Harel" }] })),
    ).toBeUndefined();
    expect(citationMetaFromSource(sourceOf({ title: "   " }))).toBeUndefined();
  });

  it("survives malformed CSL rather than throwing", () => {
    expect(
      citationMetaFromSource(
        sourceOf({
          title: "T",
          author: ["Harel", null, {}, { given: "nur Vorname" }],
          issued: { "date-parts": "kaputt" },
        }),
      ),
    ).toEqual({ title: "T", authors: [] });
  });
});
