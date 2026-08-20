import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { deriveOriginalIdentity } from "@/lib/pipeline";
import type { Source } from "@/lib/register";
import {
  AUTO_CAPTURE_METHOD_LABELS,
  autoCaptureRowNote,
} from "../auto-capture-labels";
import { buildOriginalIdentityRow } from "../original-identity-vm";
import type { OriginalIdentityRowVM } from "../original-identity-vm";
import { SourceRow, type SourceRowVM } from "./SourceRow";

/**
 * The JSX half of the original-identity block (SRC-01/03/05).
 *
 * `tests/original-identity-display.test.ts` pins what the block SAYS;
 * `lib/pipeline/sources/original-identity.test.ts` pins what the projection
 * decides. Neither reaches the rendering itself, so nothing pinned the two
 * things a reader actually depends on: that the block is on the row without
 * any interaction, and that an uncorrected row stays exactly as it was.
 *
 * Server-rendered with `renderToStaticMarkup`: `SourceRow` is a client
 * component, but its context (`ProjectEventStreamContext`) carries a default
 * value, and `useActionState` renders on the server, so no provider is needed.
 */

const BASE: SourceRowVM = {
  id: "src_1",
  citation: "Neumann et al. (2025), IEEE TSE",
  sourceTypeLabel: "Peer-Review-Publikation",
  revision: 2,
  capturedAt: "2026-08-01T10:00:00Z",
  citingClaims: 3,
  identifierVerified: true,
  fullTextExtracted: true,
  previousSnapshots: 1,
  extractionOutcome: "completed",
  currentKind: "doi",
  currentSourceType: "peer_reviewed_publication",
  previousIdentities: 1,
};

function render(source: SourceRowVM): string {
  return renderToStaticMarkup(
    <SourceRow
      projectId="p1"
      source={source}
      extractionRunning={false}
      extractingLive={false}
      corrections={[]}
      correctingLive={false}
    />,
  );
}

/** The block's markup, isolated from the rest of the row. */
function block(html: string): string {
  const start = html.indexOf("Ursprünglich erfasst als:");
  expect(start).toBeGreaterThan(-1);
  // From the container <div> that opens before the label to its close.
  const open = html.lastIndexOf("<div", start);
  return html.slice(open, html.indexOf("</div>", start) + "</div>".length);
}

const CORRECTED: SourceRowVM = {
  ...BASE,
  originalIdentity: {
    citation: "Neumann, A. (2025), unbekannter Verlag",
    capturedAtLabel: "20.07.2026, 11:00",
    provenanceLabel: "manuell erfasst",
  },
};

describe("SourceRow original-identity block", () => {
  it("shows the original identity on a corrected row without any interaction", () => {
    const html = render(CORRECTED);
    expect(html).toContain("Ursprünglich erfasst als:");
    expect(html).toContain("Neumann, A. (2025), unbekannter Verlag");
    // The corrected identity stays the row's dominant citation.
    expect(html).toContain("Neumann et al. (2025), IEEE TSE");
  });

  it("renders nothing at all for a source that was never corrected", () => {
    // SRC-01 inverse: the regression that would silently alter every existing
    // row. No label, no placeholder, no empty container.
    const html = render({ ...BASE, previousIdentities: 0 });
    expect(html).not.toContain("Ursprünglich erfasst als");
    expect(html).not.toContain("Erfasst am");
    expect(html).not.toContain("Referenztext");
    expect(html).not.toContain("bg-slate-50");
  });

  it("quotes the raw reference text of an auto-imported original in full", () => {
    const raw =
      "Neumann, A. et al. (2025): „Assistants in Code Review“, IEEE TSE 51(4), " +
      "S. 1–24, doi:10.1109/TSE.2025.1234567";
    const html = render({
      ...CORRECTED,
      originalIdentity: {
        ...CORRECTED.originalIdentity!,
        provenanceLabel: "automatisch übernommen (DOI im Text gefunden)",
        rawText: raw,
      },
    });
    expect(html).toContain("Referenztext:");
    // The text reaches the DOM whole: the clamp added for G-01-5 is CSS, so it
    // bounds the paragraph's HEIGHT and never truncates the string. Nothing is
    // dropped server-side and no ellipsis is ever written into the markup.
    expect(html).toContain(`„${raw}“`);
    expect(html).toContain("automatisch übernommen (DOI im Text gefunden)");
  });

  /**
   * G-01-5, and the reason it is a test rather than a line of CSS trusted to
   * stay: this clamp was asked for once already as code review finding WR-06
   * and correctly DECLINED, because 01-UI-SPEC.md D-06 then forbade it in three
   * approved places. The UAT decision flipped D-06. Without an assertion, the
   * next reader of a stale D-06 quote has every reason to take the clamp back
   * out, and no test would stop them.
   */
  it("clamps the Referenztext to three lines and keeps the full text reachable (G-01-5)", () => {
    const raw =
      "Neumann, A. et al. (2025): „Assistants in Code Review“, IEEE TSE 51(4), " +
      "S. 1–24, doi:10.1109/TSE.2025.1234567";
    const html = block(
      render({
        ...CORRECTED,
        originalIdentity: {
          ...CORRECTED.originalIdentity!,
          provenanceLabel: "automatisch übernommen (DOI im Text gefunden)",
          rawText: raw,
        },
      }),
    );
    expect(html).toContain("line-clamp-3");
    // The clamped-away tail stays readable without any handler or focusable
    // element: a native title tooltip, which is the whole of the D-05
    // interaction ban that this amendment spends.
    expect(html).toContain(`title="${raw}"`);
    // The clamp belongs to the Referenztext ALONE. The three lines above it
    // name the original source — clamping those would defeat the block.
    expect(html.match(/line-clamp-3/g) ?? []).toHaveLength(1);
  });

  it("shows a two-line block ending in the manual-capture wording", () => {
    const html = block(render(CORRECTED));
    expect(html).toContain("Erfasst am 20.07.2026, 11:00");
    expect(html).toContain("manuell erfasst");
    // A hand-described source has no raw text to quote — no empty quotes.
    expect(html).not.toContain("Referenztext");
    expect(html).not.toContain("„“");
    expect(html.match(/<p>/g) ?? []).toHaveLength(2);
  });

  /**
   * G-01-2, end to end. The `originalIdentity` sub-object is built by the REAL
   * `buildOriginalIdentityRow` rather than hand-written, so this single
   * assertion crosses the display tier and the JSX together.
   *
   * TWO of the three hops from the projection to the paragraph are unchecked,
   * and this is what covers them: the pipeline VM to the row VM is a
   * hand-written copy inside `buildOriginalIdentityRow`, and a field present on
   * the type but never rendered in the JSX is not a type error at all — a field
   * added at either end and not threaded through is a silent no-op. The third
   * hop, the page's assignment into `SourceRowVM`, IS type-unified since WR-03:
   * `SourceRowVM.originalIdentity` refers to `OriginalIdentityRowVM` rather
   * than restating its shape, pinned by the declaration case at the foot of
   * this file. Hand-writing the sub-object here would pin the JSX and leave
   * both remaining gaps open.
   */
  it("names the original paper by title, not by year alone (G-01-2)", () => {
    const citation =
      "Alrajeh et al. (2013), 2013 35th International Conference on " +
      "Software Engineering (ICSE)";
    const title =
      "Computational alignment of goals and scenarios for complex systems";
    const html = block(
      render({
        ...BASE,
        ...buildOriginalIdentityRow({
          citation,
          capturedAt: "2026-08-14T16:34:00Z",
          title,
        }),
      }),
    );
    expect(html).toContain(title);
    // The citation stays: the title is an added line, not a replacement.
    expect(html).toContain(citation);
    expect(html.match(/<p>/g) ?? []).toHaveLength(3);
  });

  it("prints the original title exactly once", () => {
    const title =
      "Computational alignment of goals and scenarios for complex systems";
    const html = block(
      render({
        ...BASE,
        ...buildOriginalIdentityRow({
          citation: "Alrajeh et al. (2013), ICSE",
          capturedAt: "2026-08-14T16:34:00Z",
          title,
        }),
      }),
    );
    // The failure this guards is the block naming the paper twice: the
    // projection suppresses the field where formatCitationItem already used
    // the title as the citation head, and this counts what reaches the DOM.
    expect(html.split(title)).toHaveLength(2);
  });

  /**
   * G-01-4, from a register-shaped `Source` all the way to the emitted markup.
   * A whitespace-only archived title satisfied `deriveOriginalIdentity`'s
   * RAW-length guard while `formatCitationItem`'s head branch — which trims —
   * had already read the same value as unusable, so the two sites disagreed on
   * one input and the block came out with a blank paragraph between the
   * citation line and the capture line. Reachable through a live write path:
   * `resolveDoi` stores the registrant's CSL record unfiltered.
   *
   * Composed through the REAL projection and the REAL row builder rather than a
   * hand-written VM, because the defect lived in the projection and only became
   * VISIBLE in the JSX; pinning either end alone would have missed it.
   * `deriveOriginalIdentity` comes from the `@/lib/pipeline` barrel — the one
   * runtime specifier the web-layer boundary rule permits here.
   */
  it("renders no blank line for a whitespace-only archived title (G-01-4)", () => {
    const source: Source = {
      id: "src_mayer2024",
      type: "article-journal",
      custom: {
        source_type: "peer_reviewed_publication",
        previous_identities: [
          {
            replaced_at: "2026-08-14T10:15:00Z",
            item: {
              id: "src_mayer2024",
              type: "article-journal",
              title: "   ",
              author: [{ family: "Mayer", given: "A." }],
              issued: { "date-parts": [[2024]] },
            },
          },
        ],
        previous_snapshots: [
          {
            retrieved_at: "2026-07-20T09:00:00Z",
            sha256: "a".repeat(64),
            blob_path: `blobs/aa/${"a".repeat(64)}.pdf`,
            revision: 1,
          },
        ],
      },
    };
    const html = block(
      render({
        ...BASE,
        ...buildOriginalIdentityRow(deriveOriginalIdentity(source)),
      }),
    );
    // Read paragraph-wise rather than grepping for one hard-coded blank
    // paragraph string, so the pin survives a class or tag change in
    // SourceRow.tsx. Inner tags are stripped because the first paragraph wraps
    // its label in a <span>.
    const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(
      (match) => match[1].replace(/<[^>]*>/g, ""),
    );
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const paragraph of paragraphs) {
      expect(paragraph.trim().length).toBeGreaterThan(0);
    }
    // The block still names the original: the citation head is the author, so
    // suppressing the title removes a blank line and nothing else.
    expect(html).toContain("Mayer (2024)");
  });

  it("presents the block as neutral information, not as an alarm", () => {
    const html = block(render(CORRECTED));
    // The exact neutral surface UI-SPEC pins (D-01).
    expect(html).toContain("border-slate-200");
    expect(html).toContain("bg-slate-50");
    expect(html).toContain("text-slate-600");
    expect(html).toContain("break-words");
    // Amber is this row's failure colour, green means verified, blue means
    // live, red means destructive — an original identity is none of those.
    expect(html).not.toMatch(/amber|green|blue|red/);
  });

  it("offers nothing to click inside the block", () => {
    const html = block(render(CORRECTED));
    // D-02/D-06: always visible, zero focusable elements, no disclosure.
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("mehr anzeigen");
    expect(html).not.toContain("<details");
  });
});

/**
 * WR-04, end to end. The row is assembled exactly as `page.tsx` assembles it —
 * the REAL `buildOriginalIdentityRow` decides whether the block renders, and
 * that same decision gates the REAL `autoCaptureRowNote` — so these assertions
 * cross the pipeline projection, the display tier and the JSX in one step.
 * Deciding "does the block render" a second time with an independent predicate
 * is the bug class this file pins against.
 */
describe("SourceRow capture provenance", () => {
  const RAW = "Alrajeh, D. et al. (2013): Computational alignment, ICSE.";

  /** The row `page.tsx` builds for an auto-imported source. */
  function autoImportedRow(options: {
    corrected: boolean;
    method: "unresolved" | "crossref_title";
    score?: number;
  }): SourceRowVM {
    const fragment = options.corrected
      ? buildOriginalIdentityRow({
          citation: "Alrajeh et al. (2013), ICSE",
          capturedAt: "2026-08-14T16:34:00Z",
          autoCapture: { method: options.method, rawText: RAW },
        })
      : {};
    const note = autoCaptureRowNote(
      {
        method: options.method,
        ...(options.score ? { score: options.score } : {}),
      },
      { originalIdentityShown: fragment.originalIdentity !== undefined },
    );
    return {
      ...BASE,
      previousIdentities: options.corrected ? 1 : 0,
      ...(note !== undefined ? { autoCaptureNote: note } : {}),
      ...fragment,
    };
  }

  it("states the capture provenance once, not twice, on a corrected auto-import", () => {
    const html = render(
      autoImportedRow({ corrected: true, method: "unresolved" }),
    );
    // Read from the map, never hand-typed, so the count cannot drift from the
    // wording. The block states this clause; the row-level note used to state
    // it a second time, and for `unresolved` the note wrapped it in
    // "automatisch übernommen –", contradicting the block one line above.
    expect(html.split(AUTO_CAPTURE_METHOD_LABELS.unresolved)).toHaveLength(2);
    expect(html).toContain("Ursprünglich erfasst als:");
    // Teeth: without the suppression the very same row says it twice. This is
    // what the assertion above is measuring, and it is what the row did before
    // WR-04 was fixed.
    const unsuppressed = render({
      ...autoImportedRow({ corrected: true, method: "unresolved" }),
      autoCaptureNote: `automatisch übernommen – ${AUTO_CAPTURE_METHOD_LABELS.unresolved}`,
    });
    expect(
      unsuppressed.split(AUTO_CAPTURE_METHOD_LABELS.unresolved),
    ).toHaveLength(3);
  });

  it("leaves an uncorrected auto-imported row's note in place", () => {
    // ROADMAP SC5 — passes before and after WR-04, and is what stops the fix
    // from being implemented as "delete the note".
    const html = render(
      autoImportedRow({ corrected: false, method: "unresolved" }),
    );
    expect(html).toContain(
      `automatisch übernommen – ${AUTO_CAPTURE_METHOD_LABELS.unresolved}`,
    );
    expect(html).not.toContain("Ursprünglich erfasst als");
  });

  it("keeps the match-score warning on an uncorrected fuzzy match", () => {
    const html = render(
      autoImportedRow({
        corrected: false,
        method: "crossref_title",
        score: 0.87,
      }),
    );
    expect(html).toContain(AUTO_CAPTURE_METHOD_LABELS.crossref_title);
    expect(html).toContain("87");
  });
});

/**
 * Mutual assignability, both directions. The single-element tuples stop a union
 * from distributing, so `Exact` is true only when each type is assignable to
 * the other as a whole.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("SourceRowVM declaration", () => {
  /**
   * WR-03. The doc on `OriginalIdentityRowVM` used to claim that a drift
   * between it and `SourceRowVM.originalIdentity` was a compile error. It was
   * not: the two were structurally identical declarations, and TypeScript is
   * structural, so either could grow a field the other lacked and every
   * existing assignment would still check. The claim is now made TRUE by
   * unifying the declarations, and this case is what pins it — `tsconfig.json`
   * includes every `.tsx` file under the repo, this one among them, so it runs
   * inside `npm run typecheck`, the binding gate. Drift again and the literal
   * below stops being assignable.
   */
  it("keeps SourceRowVM.originalIdentity and OriginalIdentityRowVM one declaration", () => {
    const oneDeclaration: Exact<
      SourceRowVM["originalIdentity"],
      OriginalIdentityRowVM | undefined
    > = true;
    // Mutual assignability alone cannot see an OPTIONAL field go missing:
    // `{ a; b? }` and `{ a }` are assignable to each other in both directions,
    // and two of this shape's five fields are optional. Measured, not assumed —
    // the first teeth probe for this case narrowed `rawText` away and typecheck
    // still exited 0. The key sets are what closes that hole.
    const sameFields: Exact<
      keyof NonNullable<SourceRowVM["originalIdentity"]>,
      keyof OriginalIdentityRowVM
    > = true;
    // Asserted at runtime too, so neither binding is dead code.
    expect(oneDeclaration).toBe(true);
    expect(sameFields).toBe(true);
  });
});

/**
 * The "zurücknehmen" control's visibility (three-way source correction).
 * `lib/pipeline/sources/revert-identity.test.ts` pins what the undo DOES;
 * this pins whether the row offers it at all.
 */
describe("SourceRow revert control", () => {
  it("offers the revert after a correction that archived no document", () => {
    // A metadata-only correction archives an identity and deliberately leaves
    // the frozen document alone, so previousSnapshots stays 0.
    // revertSourceIdentity handles exactly that shape; gating the control on
    // an archived document would hide the undo for it.
    const html = render({
      ...BASE,
      previousIdentities: 1,
      previousSnapshots: 0,
    });
    expect(html).toContain("Kennung korrigiert");
    expect(html).toContain("zurücknehmen");
  });

  it("offers no revert on a source that was never corrected", () => {
    const html = render({ ...BASE, previousIdentities: 0 });
    expect(html).not.toContain("zurücknehmen");
    expect(html).not.toContain("Ursprünglich erfasst als");
  });
});
