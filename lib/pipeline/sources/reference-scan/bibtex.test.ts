import { describe, expect, it } from "vitest";

import { bestIdentifier, parseBibtex } from "./bibtex";

/** Convenience: the one entry a source is expected to yield. */
function only(source: string) {
  const result = parseBibtex(source);
  expect(result.warnings).toEqual([]);
  expect(result.entries).toHaveLength(1);
  return result.entries[0];
}

describe("parseBibtex — entry structure", () => {
  it("reads type, key and braced fields", () => {
    const entry = only(`@article{smith2020,
  author = {Smith, Jane},
  title  = {A Very Ordinary Paper},
  year   = {2020},
}`);
    expect(entry.type).toBe("article");
    expect(entry.key).toBe("smith2020");
    expect(entry.fields.author).toBe("Smith, Jane");
    expect(entry.fields.title).toBe("A Very Ordinary Paper");
    expect(entry.fields.year).toBe("2020");
  });

  it("lowercases type and field names but never the key or the values", () => {
    const entry = only(`@Article{Smith2020, TITLE = {Mixed Case Title}}`);
    expect(entry.type).toBe("article");
    expect(entry.key).toBe("Smith2020");
    expect(entry.fields.title).toBe("Mixed Case Title");
  });

  it("accepts quoted and bare field values, and `#` concatenation", () => {
    const entry = only(`@misc{q, title = "Quoted Title", year = 2020,
      note = {Part one} # { and part two}}`);
    expect(entry.fields.title).toBe("Quoted Title");
    expect(entry.fields.year).toBe("2020");
    expect(entry.fields.note).toBe("Part one and part two");
  });

  it("keeps braces balanced inside a value (nested groups)", () => {
    const entry = only(
      `@misc{n, title = {Outer {inner {deepest}} tail}, year = {1999}}`,
    );
    expect(entry.fields.title).toBe("Outer inner deepest tail");
    expect(entry.fields.year).toBe("1999");
  });

  it("treats a comma inside a braced value as text, not as a separator", () => {
    const entry = only(`@misc{case, title = {Mata v. Avianca, Inc.}}`);
    expect(entry.fields.title).toBe("Mata v. Avianca, Inc.");
  });

  it("accepts parentheses as the entry delimiter", () => {
    const entry = only(`@misc(paren, title = {Round Brackets})`);
    expect(entry.key).toBe("paren");
    expect(entry.fields.title).toBe("Round Brackets");
  });

  it("reads CRLF sources", () => {
    const entry = only("@misc{crlf,\r\n  title = {Windows Line Ends}\r\n}\r\n");
    expect(entry.fields.title).toBe("Windows Line Ends");
  });

  it("keeps the FIRST occurrence of a repeated field", () => {
    const entry = only(`@misc{dupfield, title = {First}, title = {Second}}`);
    expect(entry.fields.title).toBe("First");
  });
});

describe("parseBibtex — comments", () => {
  it("ignores `%` comments between entries and after field values", () => {
    const result = parseBibtex(`% header comment with an @ in it
@article{withcomment,
  title = {Commented Entry},
  doi   = {10.1000/abc}, % TODO: verify DOI (reconstructed)
} % TODO: verify against Zotero

% trailing file comment`);
    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].fields.title).toBe("Commented Entry");
    expect(result.entries[0].fields.doi).toBe("10.1000/abc");
  });

  it("skips @comment, @preamble and @string without warning", () => {
    const result = parseBibtex(`@comment{jabref-meta: databaseType:biblatex;}
@preamble{ "\\newcommand{\\noop}[1]{}" }
@string{acl = {Association for Computational Linguistics}}
@misc{real, title = {The Only Entry}}`);
    expect(result.warnings).toEqual([]);
    expect(result.entries.map((entry) => entry.key)).toEqual(["real"]);
  });
});

describe("parseBibtex — LaTeX de-escaping", () => {
  it("resolves accents in all three spellings", () => {
    const entry = only(
      `@misc{acc, author = {M\\"antyl\\"a, Mika and {\\"O}zt\\"{u}rk, Ali and Garc\\'ia, Jos\\'{e}}}`,
    );
    expect(entry.fields.author).toBe(
      "Mäntylä, Mika and Öztürk, Ali and García, José",
    );
  });

  it("resolves the letter-named accents", () => {
    const entry = only(
      `@misc{named, author = {Fran\\c{c}ois and Nov\\'{a}k, Jan and \\v{S}koda}}`,
    );
    expect(entry.fields.author).toBe("François and Novák, Jan and Škoda");
  });

  it("resolves standalone character commands", () => {
    const entry = only(
      `@misc{lit, title = {Wei\\ss{}bier and \\AA ngstr\\o m}}`,
    );
    expect(entry.fields.title).toBe("Weißbier and Ångstrøm");
  });

  it("un-escapes punctuation and keeps protective braces out of the text", () => {
    const entry = only(
      `@misc{esc, title = {{FACTS\\&EVIDENCE}: 50\\% of {LLM} Output}, author = {{Anthropic}}}`,
    );
    expect(entry.fields.title).toBe("FACTS&EVIDENCE: 50% of LLM Output");
    expect(entry.fields.author).toBe("Anthropic");
  });

  it("turns TeX dashes and quotes into their characters", () => {
    const entry = only(
      `@misc{dash, pages = {490--501}, title = {A ---long--- ` +
        "``quoted'' title}}",
    );
    expect(entry.fields.pages).toBe("490–501");
    expect(entry.fields.title).toBe("A —long— “quoted” title");
  });

  it("collapses the line wrapping an exporter put inside a value", () => {
    const entry = only(`@misc{wrap, title = {A title that the exporter
      wrapped     across lines}}`);
    expect(entry.fields.title).toBe(
      "A title that the exporter wrapped across lines",
    );
  });
});

describe("parseBibtex — tolerance", () => {
  it("skips an unknown entry type with a German warning and reads the rest", () => {
    const result = parseBibtex(`@nonsensetype{weird, title = {Not A Real Type}}
@misc{good, title = {Perfectly Fine}}`);
    expect(result.entries.map((entry) => entry.key)).toEqual(["good"]);
    expect(result.warnings).toEqual([
      "BibTeX-Eintrag mit unbekanntem Typ „@nonsensetype“ übersprungen.",
    ]);
  });

  it("skips an unterminated entry but still reads the entries below it", () => {
    const result = parseBibtex(`@article{broken, title = {No Closing Brace}
@misc{after, title = {Read Anyway}}`);
    expect(result.entries.map((entry) => entry.key)).toEqual(["after"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Unvollständiger BibTeX-Eintrag");
  });

  it("skips an entry without a citation key", () => {
    const result = parseBibtex(`@misc{, title = {Anonymous}}`);
    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([
      "BibTeX-Eintrag vom Typ „@misc“ ohne Zitierschlüssel übersprungen.",
    ]);
  });

  it("skips an entry whose body has no readable field", () => {
    const result = parseBibtex(`@misc{empty,}`);
    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([
      "BibTeX-Eintrag „empty“ ohne lesbare Felder übersprungen.",
    ]);
  });

  it("keeps the first of two entries sharing a key and reports the second", () => {
    const result = parseBibtex(`@misc{same, title = {First}}
@misc{same, title = {Second}}`);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].fields.title).toBe("First");
    expect(result.warnings[0]).toContain("Doppelter BibTeX-Schlüssel");
  });

  it("returns nothing at all rather than throwing on junk input", () => {
    for (const junk of ["", "   ", "no entries here", "@", "@@@{{{", "@{}"]) {
      expect(() => parseBibtex(junk)).not.toThrow();
      expect(parseBibtex(junk).entries).toEqual([]);
    }
  });
});

describe("bestIdentifier", () => {
  it("prefers arXiv, declared via archiveprefix", () => {
    const entry = only(
      `@online{a, title = {T}, eprint = {2403.09724}, archiveprefix = {arXiv},
        doi = {10.1000/xyz}, url = {https://example.org/a}}`,
    );
    expect(bestIdentifier(entry)).toBe("arXiv:2403.09724");
  });

  it("accepts BibLaTeX's eprinttype spelling", () => {
    const entry = only(
      `@online{b, title = {T}, eprint = {2602.13855}, eprinttype = {arxiv}}`,
    );
    expect(bestIdentifier(entry)).toBe("arXiv:2602.13855");
  });

  it("accepts an undeclared eprint that has the arXiv id shape", () => {
    const entry = only(`@online{c, title = {T}, eprint = {2401.11817v2}}`);
    expect(bestIdentifier(entry)).toBe("arXiv:2401.11817v2");
  });

  it("ignores an eprint that is neither declared arXiv nor arXiv-shaped", () => {
    const entry = only(`@online{d, title = {T}, eprint = {hdl:1234/5678}}`);
    expect(bestIdentifier(entry)).toBeNull();
  });

  it("strips an `arXiv:` prefix the exporter left in the eprint field", () => {
    const entry = only(
      `@online{e, title = {T}, eprint = {arXiv:2509.04664}, eprinttype = {arXiv}}`,
    );
    expect(bestIdentifier(entry)).toBe("arXiv:2509.04664");
  });

  it("falls back to the DOI, spelled as a resolver URL", () => {
    const entry = only(
      `@article{f, title = {T}, doi = {10.1016/j.infsof.2018.09.006},
        url = {https://example.org/f}}`,
    );
    expect(bestIdentifier(entry)).toBe(
      "https://doi.org/10.1016/j.infsof.2018.09.006",
    );
  });

  it("accepts a doi field that was already written as a URL", () => {
    const entry = only(
      `@article{g, title = {T}, doi = {https://doi.org/10.1136/bmj.n71}}`,
    );
    expect(bestIdentifier(entry)).toBe("https://doi.org/10.1136/bmj.n71");
  });

  it("ignores a doi field that is not a DOI", () => {
    const entry = only(`@article{h, title = {T}, doi = {see the publisher}}`);
    expect(bestIdentifier(entry)).toBeNull();
  });

  it("falls back to the url, but only for http(s)", () => {
    const web = only(
      `@online{i, title = {T}, url = {https://code.claude.com/docs/en/costs}}`,
    );
    expect(bestIdentifier(web)).toBe("https://code.claude.com/docs/en/costs");
    const ftp = only(
      `@online{j, title = {T}, url = {ftp://example.org/paper}}`,
    );
    expect(bestIdentifier(ftp)).toBeNull();
  });

  it("has no identifier for an entry that carries none", () => {
    const entry = only(
      `@misc{k, title = {Mata v. Avianca, Inc.}, year = {2023}}`,
    );
    expect(bestIdentifier(entry)).toBeNull();
  });
});
