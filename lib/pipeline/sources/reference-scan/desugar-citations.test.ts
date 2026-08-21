import { describe, expect, it } from "vitest";

import {
  desugarBriefingCitations,
  desugarCitations,
} from "./desugar-citations";
import { parseBibtex } from "./bibtex";
import { footnoteMarkersIn, parseFootnoteDefinitions } from "./footnotes";
import { scanRegex } from "./scan-regex";

const BIB = `@online{alpha2026,
  author = {Alpha, Ada},
  title  = {Alpha: A Study of Things},
  year   = {2026},
  eprint = {2601.00001},
  eprinttype = {arxiv},
}

@article{beta2025,
  author = {Beta, Bob},
  title  = {Beta Considered Harmful},
  year   = {2025},
  doi    = {10.1000/beta.2025},
}

@online{gamma2024,
  title = {Gamma Vendor Documentation},
  url   = {https://example.org/gamma},
}

@misc{delta2023,
  title = {Delta v. Epsilon, Inc.},
  year  = {2023},
}`;

function rewrite(text: string, bib = BIB) {
  return desugarBriefingCitations(text, bib);
}

describe("desugarCitations — markers", () => {
  it("turns a single citation into a footnote marker", () => {
    const { text } = rewrite("Alpha misst etwas [@alpha2026].");
    expect(text).toContain("Alpha misst etwas [^alpha2026].");
  });

  it("turns a multi-key citation into one marker per key", () => {
    const { text } = rewrite("Zwei Belege [@alpha2026; @beta2025].");
    expect(text.split("\n")[0]).toBe("Zwei Belege [^alpha2026][^beta2025].");
  });

  it("rewrites Pandoc's author-suppressed form", () => {
    const { text } = rewrite("Wie [-@beta2025] zeigt.");
    expect(text).toContain("Wie [^beta2025] zeigt.");
  });

  it("rewrites a citation carrying a prefix and a locator", () => {
    const { text } = rewrite("Dazu [vgl. @beta2025, S. 12].");
    expect(text).toContain("Dazu [^beta2025].");
  });

  it("counts each bracket span once, however many keys it holds", () => {
    const { report } = rewrite(
      "Eins [@alpha2026].\n\nZwei [@beta2025; @gamma2024].",
    );
    expect(report.rewrittenCitationCount).toBe(2);
    expect(report.footnoteKeys).toEqual(["alpha2026", "beta2025", "gamma2024"]);
  });
});

describe("desugarCitations — definitions", () => {
  it("appends one definition per cited key, in first-citation order", () => {
    const { text } = rewrite("Erst [@beta2025], dann [@alpha2026].");
    const definitions = parseFootnoteDefinitions(text);
    expect(definitions.map((entry) => entry.marker)).toEqual([
      "beta2025",
      "alpha2026",
    ]);
  });

  it("does not define a key the briefing never cites", () => {
    const { text } = rewrite("Nur Alpha [@alpha2026].");
    expect(text).not.toContain("delta2023");
  });

  it("uses arXiv as the identifier when the entry has an eprint", () => {
    const { text } = rewrite("Alpha [@alpha2026].");
    expect(text).toContain(
      "[^alpha2026]: Alpha: A Study of Things. arXiv:2601.00001",
    );
  });

  it("uses the DOI, spelled as a resolver URL", () => {
    const { text } = rewrite("Beta [@beta2025].");
    expect(text).toContain(
      "[^beta2025]: Beta Considered Harmful. https://doi.org/10.1000/beta.2025",
    );
  });

  it("uses the plain url when there is neither arXiv id nor DOI", () => {
    const { text } = rewrite("Gamma [@gamma2024].");
    expect(text).toContain(
      "[^gamma2024]: Gamma Vendor Documentation. https://example.org/gamma",
    );
  });

  it("falls back to the title alone when the entry has no identifier", () => {
    const { text } = rewrite("Delta [@delta2023].");
    expect(text).toContain("[^delta2023]: Delta v. Epsilon, Inc.");
    const definition = parseFootnoteDefinitions(text)[0];
    expect(definition.title).toBe("Delta v. Epsilon, Inc");
  });

  it("leaves the briefing byte-identical when it cites nothing", () => {
    const original = "Ein Briefing ganz ohne Zitationen.\n";
    expect(rewrite(original).text).toBe(original);
  });
});

describe("desugarCitations — unresolved keys", () => {
  it("leaves a key the .bib does not know untouched and reports it", () => {
    const { text, report } = rewrite("Unbekannt [@nosuchkey2026].");
    expect(text).toContain("[@nosuchkey2026]");
    expect(report.unresolvedKeys).toEqual(["nosuchkey2026"]);
    expect(report.rewrittenCitationCount).toBe(0);
    expect(report.notes.join(" ")).toContain("nosuchkey2026");
  });

  it("splits a mixed bracket: markers for the known, citation for the rest", () => {
    const { text, report } = rewrite("Gemischt [@alpha2026; @nosuchkey2026].");
    expect(text.split("\n")[0]).toBe("Gemischt [^alpha2026][@nosuchkey2026].");
    expect(report.unresolvedKeys).toEqual(["nosuchkey2026"]);
    expect(report.footnoteKeys).toEqual(["alpha2026"]);
  });

  it("never touches pandoc-crossref references, nor reports them", () => {
    const { text, report } = rewrite(
      "Siehe Abschnitt [-@sec:einleitung] und Tabelle [-@tbl:korpus].",
    );
    expect(text).toContain("[-@sec:einleitung]");
    expect(text).toContain("[-@tbl:korpus]");
    expect(report.unresolvedKeys).toEqual([]);
  });

  it("does not rewrite an in-text `@key` outside brackets", () => {
    const original = "Schreiben Sie an alpha2026@example.org.\n";
    expect(rewrite(original).text).toBe(original);
  });
});

describe("desugarCitations — collisions with existing footnotes", () => {
  it("leaves generated labels bare when nothing collides", () => {
    const { text } = rewrite(
      "Vorhandene Fußnote.[^1]\n\nAlpha [@alpha2026].\n\n[^1]: Ein anderes Werk.",
    );
    expect(footnoteMarkersIn(text)).toContain("alpha2026");
  });

  it("prefixes ALL generated labels when one collides with a marker", () => {
    const { text, report } = rewrite(
      "Vorhandene Fußnote.[^alpha2026]\n\nAlpha [@alpha2026] und Beta [@beta2025].",
    );
    expect(report.footnoteKeys).toEqual(["bib-alpha2026", "bib-beta2025"]);
    expect(text).toContain("Alpha [^bib-alpha2026]");
    expect(text).toContain("Beta [^bib-beta2025]");
    expect(text).toContain("[^bib-alpha2026]: Alpha: A Study of Things.");
  });

  it("prefixes when the collision is with a definition rather than a marker", () => {
    const { report } = rewrite(
      "Alpha [@alpha2026].\n\n[^alpha2026]: Ein bereits vorhandener Eintrag.",
    );
    expect(report.footnoteKeys).toEqual(["bib-alpha2026"]);
  });

  it("escalates the prefix until it is free", () => {
    const { report } = rewrite(
      "Alpha [@alpha2026].\n\n[^alpha2026]: A.\n[^bib-alpha2026]: B.",
    );
    expect(report.footnoteKeys).toEqual(["bib2-alpha2026"]);
  });
});

describe("desugarCitations — report", () => {
  it("summarizes the rewrite in German", () => {
    const { report } = rewrite("Alpha [@alpha2026] und Beta [@beta2025].");
    expect(report.entryCount).toBe(4);
    expect(report.summary).toBe(
      "2 Zitationen aus 4 Einträgen in 2 Fußnoten überführt.",
    );
    expect(report.notes).toEqual([]);
  });

  it("uses the singular forms for a single citation", () => {
    const { report } = desugarBriefingCitations(
      "Alpha [@alpha2026].",
      "@online{alpha2026, title = {A}, eprint = {2601.00001}, eprinttype = {arxiv}}",
    );
    expect(report.summary).toBe(
      "1 Zitation aus 1 Eintrag in 1 Fußnote überführt.",
    );
  });

  it("says so when the .bib yields nothing readable", () => {
    const { text, report } = desugarBriefingCitations(
      "Alpha [@alpha2026].",
      "kein BibTeX, nur Text",
    );
    expect(text).toBe("Alpha [@alpha2026].");
    expect(report.entryCount).toBe(0);
    expect(report.summary).toContain("Keine lesbaren Einträge");
  });

  it("says so when the .bib is fine but the briefing cites nothing", () => {
    const { report } = rewrite("Ein Briefing ohne Zitationen.");
    expect(report.summary).toContain("keine auflösbaren Zitationen");
  });

  it("carries the parser's skipped-entry warnings into the notes", () => {
    const { report } = desugarBriefingCitations(
      "Alpha [@alpha2026].",
      `@nonsensetype{weird, title = {Skipped}}
@online{alpha2026, title = {A}, eprint = {2601.00001}, eprinttype = {arxiv}}`,
    );
    expect(report.notes).toEqual([
      "BibTeX-Eintrag mit unbekanntem Typ „@nonsensetype“ übersprungen.",
    ]);
  });
});

describe("desugarCitations — the result is what the reference scan reads", () => {
  it("hands both scan channels the same citation", () => {
    const { text } = rewrite(
      "Alpha misst etwas [@alpha2026].\n\nBeta widerspricht [@beta2025].",
    );

    const definitions = parseFootnoteDefinitions(text);
    expect(definitions.map((entry) => entry.marker)).toEqual([
      "alpha2026",
      "beta2025",
    ]);

    const hits = scanRegex(text);
    expect(hits.filter((hit) => hit.method === "arxiv")[0].arxiv_id).toBe(
      "2601.00001",
    );
    expect(hits.filter((hit) => hit.method === "doi")[0].doi).toBe(
      "10.1000/beta.2025",
    );
    // Every identifier hit sits on its own definition line, so the footnote's
    // title reaches the candidate that carries the identifier.
    for (const hit of hits) {
      expect(footnoteMarkersIn(hit.raw_text)).not.toEqual([]);
    }
  });
});

describe("desugarCitations — pre-parsed entries", () => {
  it("accepts entries and warnings the caller already parsed", () => {
    const parsed = parseBibtex(BIB);
    const { report } = desugarCitations("Alpha [@alpha2026].", parsed.entries, [
      "eine fremde Warnung",
    ]);
    expect(report.entryCount).toBe(4);
    expect(report.notes).toEqual(["eine fremde Warnung"]);
  });
});
