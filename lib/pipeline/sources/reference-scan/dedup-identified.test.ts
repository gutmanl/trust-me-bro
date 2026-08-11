import { describe, expect, it } from "vitest";

import type { ParsedReference } from "../../../adapters";
import { dropAlreadyIdentified } from "./dedup-identified";

function ref(raw_text: string, title = "T"): ParsedReference {
  return { raw_text, authors: [], title };
}

describe("dropAlreadyIdentified", () => {
  const identifiers = [
    {
      raw_text:
        "Eitan et al. schreiben zur Visualisierung szenariobasierter Programme: „…“. Quelle: https://example.org/~a/VisDoc3.pdf [^3]",
      matchedText: "https://example.org/~a/VisDoc3.pdf",
    },
    {
      raw_text:
        "Ashrov et al. prüften die Verständlichkeit. Quelle: https://doi.org/10.5220/0013440800003928 [^4]",
      matchedText: "10.5220/0013440800003928",
    },
  ];

  it("drops an LLM citation whose tokens are contained in an already-identified line", () => {
    const kept = dropAlreadyIdentified(
      [
        ref(
          "Eitan et al. schreiben zur Visualisierung szenariobasierter Programme.",
        ),
      ],
      identifiers,
    );
    expect(kept).toHaveLength(0);
  });

  it("drops a re-report the model reformatted (straight quotes vs. „…“)", () => {
    // The real failure: the model copies the citation but swaps typographic
    // for straight quotes, so a strict substring check missed it. Token
    // containment still recognizes it as the same paragraph.
    const kept = dropAlreadyIdentified(
      [
        ref(
          'Eitan et al. schreiben "…" zur Visualisierung szenariobasierter Programme.',
        ),
      ],
      identifiers,
    );
    expect(kept).toHaveLength(0);
  });

  it("drops an LLM citation that carries the identifier span itself", () => {
    const kept = dropAlreadyIdentified(
      [ref("Ashrov et al., DOI 10.5220/0013440800003928")],
      identifiers,
    );
    expect(kept).toHaveLength(0);
  });

  it("keeps a genuinely separate prose-only citation", () => {
    const kept = dropAlreadyIdentified(
      [ref("Meyer und Schulz (2020) fanden vergleichbare Resultate in Teams.")],
      identifiers,
    );
    expect(kept).toHaveLength(1);
  });

  it("keeps everything when there are no identifier hits", () => {
    const refs = [ref("A distinct citation"), ref("Another one entirely")];
    expect(dropAlreadyIdentified(refs, [])).toEqual(refs);
  });
});
