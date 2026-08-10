import { describe, expect, it } from "vitest";

import { ProjectId, SourceId } from "../register";
import {
  isValidProjectId,
  mintProjectId,
  mintSourceId,
  PROJECT_ID_HINT,
  slugify,
} from "./ids";

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

describe("project id validation for the creation form (S-12)", () => {
  it("accepts what mintProjectId produces", () => {
    expect(isValidProjectId(mintProjectId("Wirkt X bei Ä-Fragen?"))).toBe(true);
  });

  it("rejects an id without the proj_ prefix — the case the hint was missing", () => {
    // The form used to describe the allowed characters only, so replacing
    // the suggested value with a plain slug produced a server error.
    expect(isValidProjectId("beispiel-2026")).toBe(false);
    expect(isValidProjectId("proj_beispiel-2026")).toBe(true);
  });

  it("rejects uppercase, spaces and separators", () => {
    expect(isValidProjectId("proj_Beispiel")).toBe(false);
    expect(isValidProjectId("proj_mit leerzeichen")).toBe(false);
    expect(isValidProjectId("proj_a/b")).toBe(false);
    expect(isValidProjectId("proj_")).toBe(false);
  });

  it("states the prefix in the hint the form renders", () => {
    // The point of the finding: the requirement has to be readable, not
    // only enforceable.
    expect(PROJECT_ID_HINT).toContain("proj_");
  });
});
