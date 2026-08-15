import { describe, expect, it } from "vitest";

import type { ParsedReference } from "../../../adapters";
import { dropAlreadyIdentified } from "./dedup-identified";

function ref(raw_text: string, title = "T"): ParsedReference {
  return { raw_text, authors: [], title };
}

// The two covered blocks the caller builds: an inline-identified paragraph
// (prose + URL) and a claimed footnote definition.
const COVERED = [
  "Eitan et al. schreiben zur Visualisierung szenariobasierter Programme. Quelle: https://example.org/~a/VisDoc3.pdf [^3]",
  "On Visualization and Comprehension of Scenario-Based Programs",
];
const SPANS = ["https://example.org/~a/VisDoc3.pdf"];

describe("dropAlreadyIdentified", () => {
  it("drops a re-report of the inline prose (reformatted quotes and all)", () => {
    const kept = dropAlreadyIdentified(
      [
        ref(
          'Eitan et al. schreiben "…" zur Visualisierung szenariobasierter Programme.',
        ),
      ],
      COVERED,
      SPANS,
    );
    expect(kept).toHaveLength(0);
  });

  it("drops a re-report of a claimed footnote definition (different paragraph)", () => {
    // The model copied the footnote entry, not the prose — a separate block,
    // linked to the inline URL only by its marker. Token containment against
    // the claimed footnote text still catches it.
    const kept = dropAlreadyIdentified(
      [ref("On Visualization and Comprehension of Scenario-Based Programs")],
      COVERED,
      SPANS,
    );
    expect(kept).toHaveLength(0);
  });

  it("drops a re-report that carries the identifier span itself", () => {
    const kept = dropAlreadyIdentified(
      [ref("Some paper at https://example.org/~a/VisDoc3.pdf")],
      COVERED,
      SPANS,
    );
    expect(kept).toHaveLength(0);
  });

  it("keeps a genuinely separate citation", () => {
    const kept = dropAlreadyIdentified(
      [ref("Meyer und Schulz (2020) fanden vergleichbare Resultate in Teams.")],
      COVERED,
      SPANS,
    );
    expect(kept).toHaveLength(1);
  });

  it("keeps everything when nothing is covered", () => {
    const refs = [ref("A distinct citation"), ref("Another one entirely")];
    expect(dropAlreadyIdentified(refs, [], [])).toEqual(refs);
  });

  it("keeps a re-report that echoes a KNOWN identifier — it enriches", () => {
    // Prompt v1.1.0 asks the model to report the already-detected citations
    // too, with the title the regex channel cannot read. Sharing the
    // identifier, it merges rather than duplicating — and without it an
    // inline citation reaches the identity cross-check with no title.
    const enrichment: ParsedReference = {
      raw_text: "Some paper at https://example.org/~a/VisDoc3.pdf",
      authors: ["Eitan"],
      title: "On Visualization and Comprehension of Scenario-Based Programs",
      url: "https://example.org/~a/VisDoc3.pdf",
    };
    const kept = dropAlreadyIdentified([enrichment], COVERED, SPANS, SPANS);
    expect(kept).toEqual([enrichment]);
  });

  it("recognizes an arXiv echo in any form the briefing may have used", () => {
    // The regex channel stores "2601.20727"; the span it detected — and so
    // the hint the model reads — is "arXiv:2601.20727". A raw string
    // comparison would miss every arXiv enrichment and drop it on the
    // containment rule below, reopening the gap for one identifier kind
    // only. Both surface forms have to resolve to the same known id.
    const known = ["2601.20727"];
    for (const echoed of [
      "2601.20727",
      "arXiv:2601.20727",
      "arXiv:2601.20727v2",
      "https://arxiv.org/abs/2601.20727",
    ]) {
      const kept = dropAlreadyIdentified(
        [
          {
            raw_text: `Zur Sache (Ein Titel, arXiv:2601.20727).`,
            authors: [],
            title: "Ein Titel",
            arxiv_id: echoed,
          },
        ],
        ["Zur Sache (Ein Titel, arXiv:2601.20727)."],
        ["arXiv:2601.20727"],
        known,
      );
      expect(kept, echoed).toHaveLength(1);
    }
  });

  it("still drops the same work re-reported under a DIFFERENT identifier", () => {
    // The duplicate this module exists for: one work, two identifiers, which
    // no merge collapses. Passing knownIdentifiers must not weaken it.
    const kept = dropAlreadyIdentified(
      [
        {
          raw_text:
            "Eitan et al. zur Visualisierung szenariobasierter Programme.",
          authors: ["Eitan"],
          title:
            "On Visualization and Comprehension of Scenario-Based Programs",
          doi: "10.1234/other",
        },
      ],
      COVERED,
      SPANS,
      SPANS,
    );
    expect(kept).toHaveLength(0);
  });
});
