import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildOriginalIdentityRow } from "../original-identity-vm";
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
    // Full text, no truncation and no ellipsis (D-06).
    expect(html).toContain(`„${raw}“`);
    expect(html).toContain("automatisch übernommen (DOI im Text gefunden)");
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
   * assertion crosses the display tier and the JSX together: every hop from the
   * projection to the paragraph is an OPTIONAL field, so a field added at one
   * end and not threaded through is a silent no-op rather than a compile error.
   * Hand-writing the sub-object here would pin the JSX and leave exactly that
   * gap open.
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
