import { describe, expect, it } from "vitest";

import { ProjectId, SourceId } from "../register";
import { mintProjectId, mintSourceId, slugify } from "./ids";

describe("slugify", () => {
  it("lowercases and hyphenates free text", () => {
    expect(slugify("Reduzieren LLM-Reviews die Reviewzeit?")).toBe(
      "reduzieren-llm-reviews-die-reviewzeit",
    );
  });

  it("transliterates German umlauts and sharp s", () => {
    expect(slugify("Prüfung großer Änderungen")).toBe(
      "pruefung-grosser-aenderungen",
    );
  });

  it("strips diacritics of foreign characters", () => {
    expect(slugify("Étude café")).toBe("etude-cafe");
  });

  it("caps the length without a trailing hyphen", () => {
    const slug = slugify("wort ".repeat(20));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugify("???")).toBe("");
  });
});

describe("mintProjectId", () => {
  it("mints a valid project id from a research question", () => {
    const id = mintProjectId("Reduzieren LLM-Reviews die Reviewzeit?");
    expect(id).toBe("proj_reduzieren-llm-reviews-die-reviewzeit");
    expect(ProjectId.safeParse(id).success).toBe(true);
  });

  it("falls back to a generic slug for unusable questions", () => {
    expect(mintProjectId("???")).toBe("proj_projekt");
  });
});

describe("mintSourceId", () => {
  it("prefers author family plus year", () => {
    const id = mintSourceId(
      { family: "Meyer", year: 2025, title: "Effects" },
      new Set(),
    );
    expect(id).toBe("src_meyer2025");
    expect(SourceId.safeParse(id).success).toBe(true);
  });

  it("falls back to the title, then a generic slug", () => {
    expect(mintSourceId({ title: "Großer Bericht" }, new Set())).toBe(
      "src_grosser-bericht",
    );
    expect(mintSourceId({}, new Set())).toBe("src_quelle");
  });

  it("suffixes collisions deterministically", () => {
    const existing = new Set(["src_meyer2025", "src_meyer2025-2"]);
    expect(mintSourceId({ family: "Meyer", year: 2025 }, existing)).toBe(
      "src_meyer2025-3",
    );
  });
});
