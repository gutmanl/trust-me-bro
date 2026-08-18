import { describe, expect, it } from "vitest";

import type { ClaimsRegister, Source } from "../../register";
import exampleProject from "../../register/schema/__fixtures__/example-project.json";
import { formatCitation } from "./csl";
import { deriveOriginalIdentity } from "./original-identity";

function register(): ClaimsRegister {
  return structuredClone(exampleProject) as unknown as ClaimsRegister;
}

/**
 * The bibliographic core the source originally carried. Shaped like the
 * register's archive entry, which is `toPlainCsl(source)` — the full item minus
 * `custom`, so `id` and `type` are retained.
 */
const ORIGINAL_ITEM: Record<string, unknown> = {
  id: "src_meyer2025",
  type: "article-journal",
  title: "Effects of AI Assistants on Code Review Time",
  author: [{ family: "Mayer", given: "A." }],
  issued: { "date-parts": [[2024]] },
  "container-title": "ACM TOSEM",
};

/**
 * A source corrected once. Every identity correction revises the snapshot
 * before it archives the identity, so a corrected source always carries both a
 * `previous_identities` and a `previous_snapshots` entry. Capture time
 * (2026-07-20) and correction time (2026-08-14, mirrored by the current
 * snapshot's 2026-07-28) deliberately differ: that gap is what separates the
 * original capture date from the current snapshot's `retrieved_at`.
 */
function correctedSource(): Source {
  const source = register().sources[0];
  source.custom.previous_identities = [
    { replaced_at: "2026-08-14T10:15:00Z", item: { ...ORIGINAL_ITEM } },
  ];
  source.custom.previous_snapshots = [
    {
      retrieved_at: "2026-07-20T09:00:00Z",
      sha256: "a".repeat(64),
      blob_path: `blobs/aa/${"a".repeat(64)}.pdf`,
      revision: 1,
    },
  ];
  return source;
}

describe("deriveOriginalIdentity", () => {
  it("returns undefined for a source whose identity was never corrected", () => {
    const source = register().sources[0];
    expect(source.custom.previous_identities).toBeUndefined();
    expect(deriveOriginalIdentity(source)).toBeUndefined();
  });

  it("projects citation and original capture date for a manual capture", () => {
    const source = correctedSource();
    expect(deriveOriginalIdentity(source)).toEqual({
      citation: "Mayer (2024), ACM TOSEM",
      capturedAt: "2026-07-20T09:00:00Z",
      title: "Effects of AI Assistants on Code Review Time",
    });
    // The citation string being UNCHANGED next to the new title is half the
    // point of this whole-object assertion: the title is a separate projection,
    // not a change to formatCitationItem — which also produces the current
    // identity's citation, the extraction prompt's SourceContext.citation and
    // the briefing-substitution text, none of which are in scope (T-01-06).
    // The current snapshot's retrieved_at is the correction's revision, not
    // the original capture — asserting the gap keeps that confusion out.
    expect(source.custom.snapshot?.retrieved_at).toBe("2026-07-28T08:05:12Z");
  });

  /**
   * The gap this projection's title exists to close (G-01-2). On the live
   * register the archived identity and the correction share BOTH author and
   * venue: "Alrajeh et al. (2013), … (ICSE)" against "Alrajeh et al. (2009), …
   * (ICSE)". Citation alone therefore distinguishes the original from the
   * correction by its YEAR and nothing else, which is not something a reader
   * recognizes a paper by. The title is what makes it recognizable.
   */
  it("names the original paper by its title, not by its year alone", () => {
    const source = correctedSource();
    source.custom.previous_identities = [
      {
        replaced_at: "2026-08-14T16:34:00Z",
        item: {
          id: "src_alrajeh2013",
          type: "paper-conference",
          title:
            "Computational alignment of goals and scenarios for complex systems",
          author: [
            { family: "Alrajeh", given: "D." },
            { family: "Kramer", given: "J." },
          ],
          issued: { "date-parts": [[2013]] },
          "container-title":
            "2013 35th International Conference on Software Engineering (ICSE)",
        },
      },
    ];
    const projected = deriveOriginalIdentity(source);
    expect(projected?.citation).toBe(
      "Alrajeh et al. (2013), 2013 35th International Conference on " +
        "Software Engineering (ICSE)",
    );
    expect(projected?.title).toBe(
      "Computational alignment of goals and scenarios for complex systems",
    );
  });

  it("omits the auto-capture block entirely when the source was captured manually", () => {
    const projected = deriveOriginalIdentity(correctedSource());
    expect(projected).toBeDefined();
    expect(Object.hasOwn(projected as object, "autoCapture")).toBe(false);
  });

  it("carries the original entry's auto-capture method and raw text", () => {
    const source = correctedSource();
    source.custom.auto_capture = {
      raw_text: "Mayer, A. (2024): „Effects of AI Assistants“, ACM TOSEM.",
      method: "crossref_title",
      score: 0.87,
    };
    expect(deriveOriginalIdentity(source)?.autoCapture).toEqual({
      method: "crossref_title",
      rawText: "Mayer, A. (2024): „Effects of AI Assistants“, ACM TOSEM.",
    });
  });

  it("formats the archived identity through the same path as a current one", () => {
    const source = correctedSource();
    const asCurrentIdentity = {
      ...ORIGINAL_ITEM,
      custom: source.custom,
    } as unknown as Source;
    // One formatter, two callers: a second citation formatter would drift and
    // the original identity would stop reading like the current one.
    expect(deriveOriginalIdentity(source)?.citation).toBe(
      formatCitation(asCurrentIdentity),
    );
    // Pin the shared value too, so the equality above cannot be satisfied by
    // both sides collapsing to the id fallback.
    expect(deriveOriginalIdentity(source)?.citation).toBe(
      "Mayer (2024), ACM TOSEM",
    );
  });

  it("shows the first archived identity, never a later one, after several corrections", () => {
    const source = correctedSource();
    source.custom.previous_identities = [
      { replaced_at: "2026-08-14T10:15:00Z", item: { ...ORIGINAL_ITEM } },
      {
        replaced_at: "2026-08-15T11:00:00Z",
        item: {
          id: "src_meyer2025",
          type: "article-journal",
          title: "Zwischenstand",
          author: [{ family: "Schulz" }],
        },
      },
    ];
    // The array is append-only in correction order, so the intermediate
    // identity is history of the history: the block answers "what did this
    // source originally claim to be", and only [0] answers that. What the row
    // says about the ones in between is that they exist — the unchanged
    // "Kennung korrigiert" chip, which is keyed on the array being non-empty
    // and states no count. (Code review WR-05 asked for a count here; the count
    // is deliberately not shown, and this comment no longer claims it is. Full
    // history stays in the audit trail, which is where it is complete.)
    expect(deriveOriginalIdentity(source)?.citation).toBe(
      "Mayer (2024), ACM TOSEM",
    );
    expect(deriveOriginalIdentity(source)?.citation).not.toContain("Schulz");
  });

  it("still reports the first identity of a reverted source, though it now equals the current one", () => {
    const source = correctedSource();
    // A revert is itself an audited correction: it re-corrects to the archived
    // core, so the chain reads A → B → A and the archive holds [A, B]. The
    // projection then reports an original identity identical to the current
    // one. That is the expected result, not a defect — suppressing it would
    // hide that a correction and a revert ever happened.
    source.custom.previous_identities = [
      { replaced_at: "2026-08-14T10:15:00Z", item: { ...ORIGINAL_ITEM } },
      {
        replaced_at: "2026-08-15T11:00:00Z",
        item: {
          id: "src_meyer2025",
          type: "article-journal",
          title: "Effects of AI Assistants on Code Review Duration",
          author: [{ family: "Meyer", given: "A." }],
          issued: { "date-parts": [[2025, 11]] },
          "container-title": "IEEE Transactions on Software Engineering",
        },
      },
    ];
    Object.assign(source, ORIGINAL_ITEM);
    const projected = deriveOriginalIdentity(source);
    expect(projected).toBeDefined();
    expect(projected?.citation).toBe("Mayer (2024), ACM TOSEM");
    expect(projected?.citation).toBe(formatCitation(source));
  });

  /**
   * Rewritten deliberately (code review WR-02). This case previously asserted a
   * fallback to `custom.snapshot` — but on a corrected source that value IS the
   * correction's date, and the app renders it under the label "Erfasst am", so
   * the fallback made the row assert the one thing this projection exists to
   * disprove. The old assertion pinned the mislabelling in as correct; the
   * projection now fails closed instead, and this test pins THAT.
   */
  it("returns undefined rather than dating the original by the correction's snapshot", () => {
    const source = correctedSource();
    delete source.custom.previous_snapshots;
    // Reachable without a corrupt register: correctSourceIdentity and
    // reviseSource are independent transaction capabilities, and a
    // foreign-authored .tmb bundle satisfies the schema in this state.
    expect(source.custom.snapshot?.retrieved_at).toBe("2026-07-28T08:05:12Z");
    expect(deriveOriginalIdentity(source)).toBeUndefined();
  });

  it("returns undefined when the source carries no snapshot at all", () => {
    const source = correctedSource();
    delete source.custom.previous_snapshots;
    delete source.custom.snapshot;
    expect(deriveOriginalIdentity(source)).toBeUndefined();
  });

  it("renders a sparse archived identity as the formatter renders it", () => {
    const source = correctedSource();
    source.custom.previous_identities = [
      {
        replaced_at: "2026-08-14T10:15:00Z",
        item: { id: "src_meyer2025", type: "document", title: "Nur ein Titel" },
      },
    ];
    expect(deriveOriginalIdentity(source)?.citation).toBe("Nur ein Titel");
  });

  it("prints the title once when the citation already IS the title", () => {
    const source = correctedSource();
    source.custom.previous_identities = [
      {
        replaced_at: "2026-08-14T10:15:00Z",
        item: { id: "src_meyer2025", type: "document", title: "Nur ein Titel" },
      },
    ];
    const projected = deriveOriginalIdentity(source);
    // With no author family, formatCitationItem uses the title as the citation
    // HEAD. Emitting the title line unconditionally would therefore print the
    // very same string twice, one line under the other.
    expect(projected?.citation).toBe("Nur ein Titel");
    expect(Object.hasOwn(projected as object, "title")).toBe(false);
  });

  it("suppresses the title when the author array carries nothing usable", () => {
    const source = correctedSource();
    const title = "Effects of AI Assistants on Code Review Time";
    // Both arrays are present, non-empty and truthy, yet neither yields a
    // family name — so formatCitationItem falls through to the title head just
    // as a missing author array would. A hand-rolled "does the item have an
    // author key" predicate would answer yes here and double-print; sharing
    // firstAuthorFamily with the branch being mirrored is what prevents that.
    for (const author of [[null], ["Mayer, A."]]) {
      source.custom.previous_identities = [
        {
          replaced_at: "2026-08-14T10:15:00Z",
          item: { id: "src_meyer2025", type: "document", title, author },
        },
      ];
      const projected = deriveOriginalIdentity(source);
      expect(projected?.citation).toBe(title);
      expect(Object.hasOwn(projected as object, "title")).toBe(false);
    }
  });

  it("degrades an archived title that is not a usable string to no title at all", () => {
    const source = correctedSource();
    for (const title of [
      ["Computational alignment of goals and scenarios for complex systems"],
      42,
      {},
      null,
      undefined,
      "",
    ]) {
      source.custom.previous_identities = [
        {
          replaced_at: "2026-08-14T10:15:00Z",
          item: {
            id: "src_meyer2025",
            type: "article-journal",
            title,
            author: [{ family: "Mayer", given: "A." }],
            issued: { "date-parts": [[2024]] },
            "container-title": "ACM TOSEM",
          },
        },
      ];
      // A CSL title is legally an ARRAY in some producers, and the whole item
      // is schema-unvalidated `unknown` stored verbatim from a third-party
      // resolver. Coercing would render "[object Object]" and dereferencing
      // would throw — inside the server render of `/projects/[id]`, the only
      // page from which a source can be corrected, over an append-only
      // register, so the offending row could never be removed afterwards.
      expect(() => deriveOriginalIdentity(source)).not.toThrow();
      const projected = deriveOriginalIdentity(source);
      expect(projected?.citation).toBe("Mayer (2024), ACM TOSEM");
      expect(Object.hasOwn(projected as object, "title")).toBe(false);
    }
  });

  it("takes the title from the FIRST archived identity, never a later one", () => {
    const source = correctedSource();
    source.custom.previous_identities = [
      { replaced_at: "2026-08-14T10:15:00Z", item: { ...ORIGINAL_ITEM } },
      {
        replaced_at: "2026-08-15T11:00:00Z",
        item: {
          id: "src_meyer2025",
          type: "article-journal",
          title: "Zwischenstand einer Korrektur",
          author: [{ family: "Schulz" }],
        },
      },
    ];
    // Same [0]-and-nothing-else rule the citation already follows. Reading the
    // title off a different entry than the citation would be worse than reading
    // neither: the block would name one paper by an intermediate correction's
    // title under the original's citation.
    const projected = deriveOriginalIdentity(source);
    expect(projected?.title).toBe(
      "Effects of AI Assistants on Code Review Time",
    );
    expect(projected?.title).not.toContain("Zwischenstand");
  });

  it("labels an archived identity without author or title by its id", () => {
    const source = correctedSource();
    source.custom.previous_identities = [
      {
        replaced_at: "2026-08-14T10:15:00Z",
        item: { id: "src_alte_kennung", type: "document" },
      },
    ];
    expect(deriveOriginalIdentity(source)?.citation).toBe("src_alte_kennung");
    // An archived item without an id of its own falls back to the source's.
    source.custom.previous_identities = [
      { replaced_at: "2026-08-14T10:15:00Z", item: { type: "document" } },
    ];
    expect(deriveOriginalIdentity(source)?.citation).toBe("src_meyer2025");
  });

  it("ignores an unusable archived id and labels by the source's own", () => {
    const source = correctedSource();
    for (const id of ["", 42, { toString: () => "nope" }, null, undefined]) {
      source.custom.previous_identities = [
        { replaced_at: "2026-08-14T10:15:00Z", item: { type: "document", id } },
      ];
      // An empty string used to slip past `??` and render an EMPTY citation
      // under "Ursprünglich erfasst als:", and a non-string used to render as
      // "[object Object]" — both void the fallback's entire reason for
      // existing. `item.id` is unvalidated `unknown`, so only a non-empty
      // string may be trusted; everything else falls through to the schema's
      // own SourceId.
      expect(deriveOriginalIdentity(source)?.citation).toBe("src_meyer2025");
    }
  });

  /**
   * The "never throws" contract in the JSDoc, pinned against the shape the
   * archive actually permits: `previous_identities[].item` is a bare
   * `z.record(z.string(), z.unknown())`, and for a DOI-resolved source the item
   * was stored verbatim from the resolver's response. A throw here fails the
   * render of the whole project page — the only page from which the source can
   * be corrected — and the register is append-only, so the row could not be
   * removed afterwards.
   */
  it("never throws on an archived identity whose author array is malformed", () => {
    const source = correctedSource();
    source.custom.previous_identities = [
      {
        replaced_at: "2026-08-14T10:15:00Z",
        item: { id: "src_meyer2025", type: "document", author: [null] },
      },
    ];
    expect(() => deriveOriginalIdentity(source)).not.toThrow();
    // No author and no title: the citation degrades to the archived id, exactly
    // as a missing author array would.
    expect(deriveOriginalIdentity(source)?.citation).toBe("src_meyer2025");

    source.custom.previous_identities = [
      {
        replaced_at: "2026-08-14T10:15:00Z",
        item: {
          id: "src_meyer2025",
          type: "document",
          title: "Effects of AI Assistants on Code Review Time",
          author: ["Mayer, A."],
        },
      },
    ];
    expect(deriveOriginalIdentity(source)?.citation).toBe(
      "Effects of AI Assistants on Code Review Time",
    );
  });

  it("passes the raw reference text through byte for byte", () => {
    const source = correctedSource();
    const raw =
      "  Mayer, A. (2024): „Effects of AI Assistants“ — ACM TOSEM 33(4), S. 1–28.  ";
    source.custom.auto_capture = { raw_text: raw, method: "unresolved" };
    // No trimming, no truncation, no normalisation: for an auto-imported
    // source the raw text IS what the reader recognizes the entry by, so any
    // tidying would edit the evidence.
    expect(deriveOriginalIdentity(source)?.autoCapture).toEqual({
      method: "unresolved",
      rawText: raw,
    });
  });
});
