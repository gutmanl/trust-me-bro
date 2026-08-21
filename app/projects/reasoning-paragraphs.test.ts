import { describe, expect, it } from "vitest";

import {
  classifyReasoningParagraph,
  REASONING_ROLE_MARKERS,
  reasoningRoleClassName,
  splitReasoningParagraphs,
  type ReasoningRole,
} from "./reasoning-paragraphs";

describe("splitReasoningParagraphs", () => {
  it("keeps a single paragraph whole (old prompts)", () => {
    expect(
      splitReasoningParagraphs("Der Auszug nennt die Kennzahl wörtlich."),
    ).toEqual(["Der Auszug nennt die Kennzahl wörtlich."]);
  });

  it("splits on blank lines and trims", () => {
    expect(
      splitReasoningParagraphs(
        "Der Auszug stützt die Aussage.\n\nJedoch: nur für n = 120.",
      ),
    ).toEqual(["Der Auszug stützt die Aussage.", "Jedoch: nur für n = 120."]);
  });

  it("collapses extra blank lines and drops empty fragments", () => {
    expect(splitReasoningParagraphs("Eins.\n\n\n\nZwei.\n\n")).toEqual([
      "Eins.",
      "Zwei.",
    ]);
  });
});

/** Roles of a whole stored reasoning, the way the card derives them. */
function rolesOf(reasoning: string): ReasoningRole[] {
  return splitReasoningParagraphs(reasoning).map(classifyReasoningParagraph);
}

const CAVEAT_CLASS = "border-l-2 border-amber-300 pl-2 text-amber-800";

describe("classifyReasoningParagraph — the backward-compatibility matrix", () => {
  it("1. legacy, one paragraph, no marker → unmarked, no tier label", () => {
    expect(rolesOf("Der Auszug nennt die Kennzahl wörtlich.")).toEqual([
      "unmarked",
    ]);
    expect(reasoningRoleClassName("unmarked")).toBeUndefined();
  });

  it("2. legacy, two paragraphs, no marker → both unmarked", () => {
    // The dangerous case: a position-based parser would label the first
    // paragraph a plain summary and the second the technical justification,
    // telling the reviewer that a specialist sentence is the simple one.
    expect(
      rolesOf(
        "Der Auszug nennt die Kennzahl wörtlich.\n\n" +
          "Die Rubrik verlangt eine begutachtete Studie; sie liegt vor.",
      ),
    ).toEqual(["unmarked", "unmarked"]);
  });

  it("3. legacy, two paragraphs, the second a Jedoch: caveat", () => {
    // Byte-identical to today's rendering: no class on the first paragraph,
    // today's amber rule on the second.
    const roles = rolesOf(
      "Der Auszug stützt die Aussage.\n\nJedoch: nur für n = 120.",
    );
    expect(roles).toEqual(["unmarked", "caveat"]);
    expect(reasoningRoleClassName(roles[0])).toBeUndefined();
    expect(reasoningRoleClassName(roles[1])).toBe(CAVEAT_CLASS);
  });

  it("4. fully marked, three paragraphs", () => {
    expect(
      rolesOf(
        "Einfach gesagt: der Beleg passt zur Aussage.\n\n" +
          "Jedoch: nur für n = 120.\n\n" +
          "Technisch: Regel min_pertinent_sources ist erfüllt.",
      ),
    ).toEqual(["plain", "caveat", "technical"]);
  });

  it("5. marked but missing the technical marker", () => {
    // An absent marker is an absent claim about the tier, never an
    // inference from position — the second paragraph is unmarked, not
    // technical.
    const roles = rolesOf(
      "Einfach gesagt: der Beleg passt.\n\n" +
        "Die Rubrik verlangt zwei unabhängige Quellen.",
    );
    expect(roles).toEqual(["plain", "unmarked"]);
    expect(reasoningRoleClassName(roles[1])).toBeUndefined();
  });

  it("6. marker mid-paragraph is not a marker", () => {
    // Fails if anyone reaches for a substring search instead of an
    // anchored prefix.
    expect(classifyReasoningParagraph("Es gilt Jedoch: nur für n = 120.")).toBe(
      "unmarked",
    );
    expect(
      classifyReasoningParagraph("Der Punkt Technisch: bleibt offen."),
    ).toBe("unmarked");
  });

  it("7. different capitalisation or leading whitespace is not a marker", () => {
    // Today's predicate is an exact startsWith("Jedoch:"), and preserving
    // today's rendering byte for byte is the requirement. Trimming belongs
    // to splitReasoningParagraphs, not here.
    expect(classifyReasoningParagraph("jedoch: nur für n = 120.")).toBe(
      "unmarked",
    );
    expect(classifyReasoningParagraph(" Jedoch: nur für n = 120.")).toBe(
      "unmarked",
    );
    expect(classifyReasoningParagraph("TECHNISCH: die Regel greift.")).toBe(
      "unmarked",
    );
  });
});

describe("reasoning role markers and styling", () => {
  it("exposes exactly the three role markers", () => {
    expect([...REASONING_ROLE_MARKERS]).toEqual([
      "Einfach gesagt:",
      "Jedoch:",
      "Technisch:",
    ]);
  });

  it("gives the unmarked role no styling at all", () => {
    expect(reasoningRoleClassName("unmarked")).toBeUndefined();
    for (const role of ["plain", "caveat", "technical"] as const) {
      expect(reasoningRoleClassName(role)?.length).toBeGreaterThan(0);
    }
  });

  it("keeps the technical layer subordinate but not concealed", () => {
    // Subordination is carried by typography — smaller, quieter, a thin
    // left rule — in the same block. It is never moved behind a second
    // disclosure: the rule name and the decisive phrase are the auditable
    // content, and hiding them defeats the audit purpose.
    const technical = reasoningRoleClassName("technical") ?? "";
    expect(technical).toContain("text-[11px]");
    expect(technical).toContain("text-slate-500");
  });
});
