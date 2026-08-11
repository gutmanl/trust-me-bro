import { describe, expect, it } from "vitest";

import { scanRegex } from "./scan-regex";

describe("scanRegex", () => {
  it("finds a DOI in running prose and canonicalizes it", () => {
    const hits = scanRegex(
      "Meyer et al. zeigen dies unter https://doi.org/10.1109/TSE.2025.3489012 (2025).",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      method: "doi",
      doi: "10.1109/TSE.2025.3489012",
    });
  });

  it("finds a bare DOI (not spelled as a doi.org URL) and trims trailing punctuation", () => {
    const hits = scanRegex("Siehe 10.1000/xyz123, veröffentlicht 2024.");
    expect(hits).toHaveLength(1);
    expect(hits[0].doi).toBe("10.1000/xyz123");
  });

  it("recognizes an arXiv id only with an explicit arXiv: prefix", () => {
    const withPrefix = scanRegex("arXiv:2401.12345 beschreibt das Verfahren.");
    expect(withPrefix).toHaveLength(1);
    expect(withPrefix[0]).toMatchObject({
      method: "arxiv",
      arxiv_id: "2401.12345",
    });

    // A bare number of the same shape, with no prefix, is NOT a citation —
    // false-positive discipline.
    const bareNumber = scanRegex("Die Tabelle 2401.12345 zeigt Rohdaten.");
    expect(bareNumber).toHaveLength(0);
  });

  it("recognizes an arXiv id from an arxiv.org URL", () => {
    const hits = scanRegex("Volltext: https://arxiv.org/abs/2401.12345v2");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: "arxiv", arxiv_id: "2401.12345" });
  });

  it("finds a plain URL but excludes doi.org and arxiv.org hosts", () => {
    const hits = scanRegex(
      [
        "Blogbeitrag: https://blog.example.org/post.",
        "Auch https://doi.org/10.1000/xyz123 wird erwähnt.",
        "Und https://arxiv.org/abs/2401.12345.",
      ].join("\n"),
    );
    const urlHits = hits.filter((hit) => hit.method === "url");
    expect(urlHits).toHaveLength(1);
    expect(urlHits[0].url).toBe("https://blog.example.org/post");
  });

  it("uses the containing (trimmed) line as raw_text", () => {
    const hits = scanRegex("   Siehe 10.1000/xyz123 für Details.   ");
    expect(hits[0].raw_text).toBe("Siehe 10.1000/xyz123 für Details.");
  });

  it("scans multiple lines and returns one hit per line", () => {
    const hits = scanRegex(
      [
        "10.1000/aaa111 auf Zeile eins.",
        "",
        "10.1000/bbb222 auf Zeile zwei.",
      ].join("\n"),
    );
    expect(hits.map((hit) => hit.doi)).toEqual([
      "10.1000/aaa111",
      "10.1000/bbb222",
    ]);
  });

  it("finds nothing in a briefing without any citation", () => {
    expect(scanRegex("Nur Fließtext ohne jede Referenz.")).toEqual([]);
  });

  it("detects a Markdown footnote definition as a textual reference with a cleaned title", () => {
    const hits = scanRegex(
      "Der Effekt ist belegt.[^1]\n\n[^1]: A Study on the Comprehensibility of Behavioral Programming Variants | OpenReview.",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      method: "textual",
      title:
        "A Study on the Comprehensibility of Behavioral Programming Variants",
    });
    expect(hits[0].raw_text).toContain("OpenReview");
  });

  it("handles an Elicit-truncated footnote title", () => {
    const hits = scanRegex(
      "[^2]: On Visualization and Comprehension of Scenario-Based ...",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      method: "textual",
      title: "On Visualization and Comprehension of Scenario-Based",
    });
  });

  it("leaves a footnote that carries its own DOI to the identifier channel", () => {
    const hits = scanRegex("[^3]: Some paper. https://doi.org/10.1000/xyz");
    // The DOI hit wins; no duplicate textual hit for the same footnote.
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: "doi", doi: "10.1000/xyz" });
  });

  it("does not treat a footnote MARKER in prose as a reference", () => {
    // A `[^1]` reference marker inside a sentence is not a definition line.
    expect(scanRegex("Der Effekt ist belegt.[^1]")).toEqual([]);
  });
});
