import { describe, expect, it } from "vitest";

import { footnoteMarkersIn, parseFootnoteDefinitions } from "./footnotes";

describe("parseFootnoteDefinitions", () => {
  it("parses definitions and cleans their titles", () => {
    const defs = parseFootnoteDefinitions(
      [
        "Der Effekt ist belegt.[^1][^2]",
        "",
        "[^1]: A Study on the Comprehensibility of Behavioral Programming Variants | OpenReview.",
        "[^2]: On Visualization and Comprehension of Scenario-Based ...",
      ].join("\n"),
    );
    expect(defs).toHaveLength(2);
    expect(defs[0]).toMatchObject({
      marker: "1",
      title:
        "A Study on the Comprehensibility of Behavioral Programming Variants",
    });
    expect(defs[0].rawText).toContain("OpenReview");
    expect(defs[1].title).toBe(
      "On Visualization and Comprehension of Scenario-Based",
    );
  });

  it("ignores an inline marker that is not a definition line", () => {
    expect(parseFootnoteDefinitions("Der Effekt ist belegt.[^1]")).toEqual([]);
  });
});

describe("footnoteMarkersIn", () => {
  it("extracts the marker labels from a prose line", () => {
    expect(
      footnoteMarkersIn("… reduziert.[^1][^2] und weiter [^foo]."),
    ).toEqual(["1", "2", "foo"]);
  });

  it("returns nothing when there is no marker", () => {
    expect(footnoteMarkersIn("Fließtext ohne Marker.")).toEqual([]);
  });
});
