import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CorrectSourceForm, IdentityFields, ManualFields } from "./SourceForms";

/**
 * The first tests for the source modals. Written because the coverage
 * ratchet reaches only `lib/**` and `cli/**`, so nothing under `app/**` was
 * visible to it at all.
 *
 * WHAT THIS FILE CANNOT COVER, stated plainly rather than implied away:
 * vitest runs in the node environment with no jsdom (vitest.config.ts), so
 * these are static renders. Tab switching, the derive→confirm step change,
 * the manual fallback and modal open/close are all `useState`-driven and
 * need a browser to exercise. That is `tests/browser/`'s job, not this
 * file's — do not read a green run here as "the modal works".
 *
 * What it DOES pin is the part that is decided at render time by props:
 * which inputs each kind emits, and the metadata-mode invariant that no
 * document input is offered for any kind.
 */

const KINDS = ["doi", "arxiv", "url", "upload"] as const;

function renderIdentityFields(
  kind: (typeof KINDS)[number],
  withDocument: boolean,
): string {
  return renderToStaticMarkup(
    <IdentityFields
      kind={kind}
      onKindChange={() => {}}
      withDocument={withDocument}
    />,
  );
}

describe("IdentityFields with withDocument={false}", () => {
  // The metadata-only mode's whole promise: the full kind tabs stay, but
  // nothing that would re-acquire a document is on screen. If this breaks,
  // "Nur Metadaten korrigieren" silently starts asking for the document
  // again — which is the bug the mode was added to remove.
  for (const kind of KINDS) {
    it(`offers no document input for the "${kind}" kind`, () => {
      const html = renderIdentityFields(kind, false);
      expect(html).not.toContain('type="file"');
      expect(html).not.toContain('name="document_url"');
    });

    it(`keeps the full kind tabs for the "${kind}" kind`, () => {
      const html = renderIdentityFields(kind, false);
      for (const label of ["DOI", "arXiv", "URL", "Datei"]) {
        expect(html).toContain(label);
      }
    });
  }
});

describe("IdentityFields with the default withDocument", () => {
  it("still renders the file input for the upload kind", () => {
    const html = renderToStaticMarkup(
      <IdentityFields kind="upload" onKindChange={() => {}} />,
    );
    expect(html).toContain('type="file"');
  });

  it("still renders the document URL for the doi kind", () => {
    const html = renderToStaticMarkup(
      <IdentityFields kind="doi" onKindChange={() => {}} />,
    );
    expect(html).toContain('name="document_url"');
    expect(html).toContain('type="file"');
  });

  it("offers no file input for the url kind, whose document comes from the URL", () => {
    const html = renderToStaticMarkup(
      <IdentityFields kind="url" onKindChange={() => {}} />,
    );
    expect(html).not.toContain('type="file"');
  });
});

describe("ManualFields", () => {
  it("pre-fills every supplied default", () => {
    const html = renderToStaticMarkup(
      <ManualFields
        required
        defaults={{
          title: "Computational alignment of goals and scenarios",
          authors: "Alrajeh, Dalal",
          year: "2013",
          container_title: "ICSE",
        }}
      />,
    );
    expect(html).toContain(
      'value="Computational alignment of goals and scenarios"',
    );
    expect(html).toContain('value="Alrajeh, Dalal"');
    expect(html).toContain('value="2013"');
    expect(html).toContain('value="ICSE"');
  });

  it("emits no stray value attributes without defaults", () => {
    const html = renderToStaticMarkup(<ManualFields required />);
    expect(html).not.toContain("value=");
  });

  it("marks the title optional when it is not required", () => {
    const html = renderToStaticMarkup(<ManualFields required={false} />);
    expect(html).toContain("(optional)");
    expect(html).not.toContain("required=");
  });
});

describe("CorrectSourceForm", () => {
  it("renders only its trigger, with no modal markup before it is opened", () => {
    const html = renderToStaticMarkup(
      <CorrectSourceForm
        projectId="p1"
        sourceId="src_alrajeh2013"
        currentKind="doi"
        currentSourceType="peer_reviewed_publication"
      />,
    );
    expect(html).toContain("Quelle korrigieren …");
    // The modal mounts on open; nothing of it may leak into the closed row.
    expect(html).not.toContain("Nur Metadaten korrigieren");
    expect(html).not.toContain("Kennung und Dokument korrigieren");
    expect(html).not.toContain("<form");
  });
});
