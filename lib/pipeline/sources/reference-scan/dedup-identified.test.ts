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
});
