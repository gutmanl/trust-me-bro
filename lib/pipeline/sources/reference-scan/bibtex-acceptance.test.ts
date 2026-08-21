import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseBibtex } from "./bibtex";
import { desugarBriefingCitations } from "./desugar-citations";
import { footnoteMarkersIn, parseFootnoteDefinitions } from "./footnotes";
import { scanRegex } from "./scan-regex";

/**
 * Acceptance test for the BibTeX support: "covers the thesis".
 *
 * The fixtures are the real material this feature exists for — the thesis's
 * own `bibliography.bib`, verbatim, and a briefing-form excerpt of its
 * Stand-der-Technik chapter (paraphrased, one atomic claim per paragraph,
 * Pandoc `[@key]` citations). Everything below is stated about THAT pair, so
 * a regression shows up as "the thesis no longer imports" rather than as a
 * unit-level detail.
 *
 * The load-bearing claim is the last one: after the rewrite, both existing
 * scan channels — footnotes and regex — read the briefing as if a
 * conventional deep-research tool had written it. That is the entire reason
 * the design desugars at import instead of adding a BibTeX scan channel.
 */

const bibtex = readFileSync(
  new URL("./__fixtures__/thesis-bibliography.bib", import.meta.url),
  "utf8",
);
const pandocBriefing = readFileSync(
  new URL("./__fixtures__/stand-der-technik-briefing.md", import.meta.url),
  "utf8",
);

const parsed = parseBibtex(bibtex);
const { text: desugared, report } = desugarBriefingCitations(
  pandocBriefing,
  bibtex,
);
const definitions = parseFootnoteDefinitions(desugared);
const definitionByMarker = new Map(
  definitions.map((entry) => [entry.marker, entry]),
);

describe("the thesis bibliography reads cleanly", () => {
  it("yields every entry, with no skips to report", () => {
    expect(parsed.entries).toHaveLength(41);
    expect(parsed.warnings).toEqual([]);
  });

  it("de-escapes the LaTeX the export actually contains", () => {
    const byKey = new Map(
      parsed.entries.map((entry) => [entry.key, entry.fields]),
    );
    expect(byKey.get("garousiMlr2019")?.author).toContain("Mäntylä");
    expect(byKey.get("factsevidence2025")?.title).toMatch(/^FACTS&EVIDENCE:/u);
    expect(byKey.get("anthropiccosts2026")?.author).toBe("Anthropic");
    expect(byKey.get("citelab2025")?.pages).toBe("490–501");
  });
});

describe("the Stand-der-Technik excerpt desugars completely", () => {
  it("resolves every key the excerpt cites", () => {
    expect(report.unresolvedKeys).toEqual([]);
    expect(report.rewrittenCitationCount).toBeGreaterThan(20);
    expect(definitions.length).toBe(report.footnoteKeys.length);
  });

  it("leaves no Pandoc citation behind", () => {
    expect(desugared).not.toMatch(/\[@/u);
    expect(desugared).not.toMatch(/;\s*@/u);
  });

  it("keeps the chapter's pandoc-crossref reference untouched", () => {
    expect(desugared).toContain("[-@sec:grundlagen-fehlertaxonomie]");
  });

  it("rewrites a multi-key citation that spans a line break", () => {
    expect(desugared).toContain(
      "[^citationfaithfulness2026][^rubricjudges2026]",
    );
    expect(desugared).toContain("[^traceabletext2024][^traceabletexts2025]");
  });

  it("marks every definition it appended inline as well", () => {
    const markers = new Set(footnoteMarkersIn(desugared));
    for (const key of report.footnoteKeys) {
      expect(markers).toContain(key);
    }
  });
});

describe("identifiers reach the footnote definitions", () => {
  it("gives every cited arXiv entry its arXiv identifier", () => {
    const arxivKeys = parsed.entries
      .filter(
        (entry) =>
          entry.fields.eprint !== undefined &&
          report.footnoteKeys.includes(entry.key),
      )
      .map((entry) => entry.key);
    // The corpus is arXiv-heavy; if this ever drops to a handful the
    // assertion below has stopped meaning anything.
    expect(arxivKeys.length).toBeGreaterThan(15);
    for (const key of arxivKeys) {
      const eprint = parsed.entries.find((entry) => entry.key === key)?.fields
        .eprint;
      expect(definitionByMarker.get(key)?.rawText).toContain(`arXiv:${eprint}`);
    }
  });

  it("gives a DOI-only entry its resolver URL", () => {
    expect(definitionByMarker.get("garousiMlr2019")?.rawText).toContain(
      "https://doi.org/10.1016/j.infsof.2018.09.006",
    );
    expect(definitionByMarker.get("prisma2020")?.rawText).toContain(
      "https://doi.org/10.1136/bmj.n71",
    );
  });

  it("gives a web-only entry its url", () => {
    expect(definitionByMarker.get("anthropiccosts2026")?.rawText).toContain(
      "https://code.claude.com/docs/en/costs",
    );
  });

  it("falls back to the title alone where the entry carries no identifier", () => {
    // These two are the ONLY entries in the thesis bibliography without any
    // identifier — the title-only path exists for exactly this case, and the
    // existing Crossref title resolution takes it from here.
    expect(definitionByMarker.get("wohlin2014")?.rawText).toBe(
      "Guidelines for snowballing in systematic literature studies and a replication in software engineering",
    );
    expect(definitionByMarker.get("mata2023avianca")?.rawText).toBe(
      "Mata v. Avianca, Inc.",
    );
    expect(definitionByMarker.get("mata2023avianca")?.title).toBe(
      "Mata v. Avianca, Inc",
    );
  });
});

describe("the desugared briefing parses through both scan channels", () => {
  const hits = scanRegex(desugared);

  it("hands the regex channel exactly the cited arXiv ids, once each", () => {
    const found = hits
      .filter((hit) => hit.method === "arxiv")
      .map((hit) => hit.arxiv_id);
    const expected = parsed.entries
      .filter(
        (entry) =>
          entry.fields.eprint !== undefined &&
          report.footnoteKeys.includes(entry.key),
      )
      .map((entry) => entry.fields.eprint);
    expect([...found].sort()).toEqual([...expected].sort());
    // Co-audit, cited in the excerpt, as a named example of the above.
    expect(found).toContain("2310.01297");
  });

  it("hands the regex channel the DOIs", () => {
    const dois = hits
      .filter((hit) => hit.method === "doi")
      .map((hit) => hit.doi);
    expect(dois).toContain("10.1016/j.infsof.2018.09.006");
    expect(dois).toContain("10.18653/v1/2025.acl-demo.47");
  });

  it("hands the regex channel the plain web sources", () => {
    const urls = hits
      .filter((hit) => hit.method === "url")
      .map((hit) => hit.url);
    expect(urls).toContain("https://code.claude.com/docs/en/costs");
    expect(urls).toContain(
      "https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/",
    );
  });

  it("puts every identifier on a line the footnote channel also claims", () => {
    // This is what makes the two channels describe ONE citation rather than
    // two: the identifier sits on its own `[^key]: …` definition line, so
    // run-reference-scan's claimed-marker pass gives that candidate the
    // footnote's title instead of suggesting the paper twice.
    for (const hit of hits) {
      const markers = footnoteMarkersIn(hit.raw_text);
      expect(markers).toHaveLength(1);
      expect(definitionByMarker.has(markers[0])).toBe(true);
    }
  });

  it("leaves nothing for the scan to find in the prose itself", () => {
    // Every hit came from the appended definition block; the paraphrased
    // claims carry markers only. A briefing whose prose still held raw
    // identifiers would mean the rewrite had duplicated them.
    const prose = desugared.slice(0, desugared.indexOf("[^"));
    expect(scanRegex(prose)).toEqual([]);
  });
});
