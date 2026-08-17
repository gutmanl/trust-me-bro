import { describe, expect, it } from "vitest";

import type { Source } from "../../register";
import {
  buildManualCslItem,
  firstAuthorFamily,
  formatCitation,
  formatCitationItem,
  issuedYear,
  parseAuthors,
  toPlainCsl,
} from "./csl";

describe("parseAuthors", () => {
  it("parses 'Family, Given' entries separated by semicolons", () => {
    expect(parseAuthors("Meyer, Anna; Schulz, B.")).toEqual([
      { family: "Meyer", given: "Anna" },
      { family: "Schulz", given: "B." },
    ]);
  });

  it("keeps entries without comma as literal names", () => {
    expect(parseAuthors("Arbeitsgruppe Softwaretechnik")).toEqual([
      { literal: "Arbeitsgruppe Softwaretechnik" },
    ]);
  });

  it("ignores empty entries", () => {
    expect(parseAuthors(" ; Meyer, Anna; ")).toEqual([
      { family: "Meyer", given: "Anna" },
    ]);
  });
});

describe("buildManualCslItem", () => {
  it("maps the manual fields onto CSL-JSON", () => {
    expect(
      buildManualCslItem({
        title: "Interner Bericht",
        authors: "Meyer, Anna",
        year: "2024",
        container_title: "Techreport-Reihe",
        url: "https://example.org/report",
      }),
    ).toEqual({
      type: "webpage",
      title: "Interner Bericht",
      author: [{ family: "Meyer", given: "Anna" }],
      issued: { "date-parts": [[2024]] },
      "container-title": "Techreport-Reihe",
      URL: "https://example.org/report",
    });
  });

  it("omits absent fields and ignores non-numeric years", () => {
    expect(
      buildManualCslItem({ title: "Nur Titel", year: "irgendwann" }),
    ).toEqual({
      type: "document",
      title: "Nur Titel",
    });
  });
});

describe("toPlainCsl (F4)", () => {
  it("strips exactly the custom block", () => {
    const source = {
      id: "src_meyer2025",
      type: "article-journal",
      title: "Effects",
      custom: {
        source_type: "peer_reviewed_publication",
        snapshot: {
          retrieved_at: "2026-08-06T08:00:00Z",
          sha256: "a".repeat(64),
          blob_path: `blobs/aa/${"a".repeat(64)}.pdf`,
          revision: 1,
        },
      },
    } as unknown as Source;
    expect(toPlainCsl(source)).toEqual({
      id: "src_meyer2025",
      type: "article-journal",
      title: "Effects",
    });
  });
});

describe("formatCitation", () => {
  const base = {
    id: "src_meyer2025",
    type: "article-journal",
    custom: { source_type: "peer_reviewed_publication" },
  };

  it("formats author, year and container", () => {
    const source = {
      ...base,
      title: "Effects",
      author: [{ family: "Meyer", given: "A." }],
      issued: { "date-parts": [[2025, 11]] },
      "container-title": "IEEE TSE",
    } as unknown as Source;
    expect(formatCitation(source)).toBe("Meyer (2025), IEEE TSE");
  });

  it("marks multiple authors with et al.", () => {
    const source = {
      ...base,
      author: [{ family: "Meyer" }, { family: "Schulz" }],
      issued: { "date-parts": [[2025]] },
    } as unknown as Source;
    expect(formatCitation(source)).toBe("Meyer et al. (2025)");
  });

  it("derives a family name from literal authors", () => {
    const source = {
      ...base,
      author: [{ literal: "Anna Meyer" }],
    } as unknown as Source;
    expect(formatCitation(source)).toBe("Meyer");
  });

  it("falls back to title, then id", () => {
    expect(
      formatCitation({ ...base, title: "Nur Titel" } as unknown as Source),
    ).toBe("Nur Titel");
    expect(formatCitation(base as unknown as Source)).toBe("src_meyer2025");
  });
});

describe("issuedYear / firstAuthorFamily edge cases", () => {
  it("returns undefined for malformed shapes", () => {
    expect(issuedYear({ issued: { "date-parts": "kaputt" } })).toBeUndefined();
    expect(issuedYear({})).toBeUndefined();
    expect(firstAuthorFamily({ author: [] })).toBeUndefined();
    expect(firstAuthorFamily({ author: [{}] })).toBeUndefined();
  });

  /**
   * Author entries reach this function unvalidated — `previous_identities[].item`
   * is a bare record, `Source` is a looseObject, and a DOI-resolved item is
   * stored verbatim from the resolver's response. Every one of these shapes used
   * to be either a TypeError or a lie, and the throw happened inside the project
   * page's server render, i.e. it took down the only page from which the source
   * could be corrected. "No author" is the only honest answer to any of them.
   */
  it("degrades a malformed author entry to no author instead of throwing", () => {
    expect(firstAuthorFamily({ author: [null] })).toBeUndefined();
    expect(firstAuthorFamily({ author: [undefined] })).toBeUndefined();
    // A bare string entry never threw, but nothing pinned it either: a string
    // has no `.family`, so the item must fall through to title/id — never to
    // the string's own characters.
    expect(firstAuthorFamily({ author: ["Mayer, A."] })).toBeUndefined();
    expect(firstAuthorFamily({ author: [42] })).toBeUndefined();
    // The whole citation path, not just the accessor: a null first author must
    // still yield the title (and, with no title, the fallback label).
    expect(
      formatCitationItem(
        { id: "src_x", title: "Nur Titel", author: [null] },
        "src_x",
      ),
    ).toBe("Nur Titel");
    expect(formatCitationItem({ author: [null] }, "src_x")).toBe("src_x");
    // A second, well-formed entry does not rescue a malformed first one — the
    // et-al suffix is keyed on the array length, so the head must not silently
    // become the second author's name.
    expect(
      formatCitationItem(
        { title: "Titel", author: [null, { family: "Schulz" }] },
        "src_x",
      ),
    ).toBe("Titel");
  });
});
