import { describe, expect, it } from "vitest";

import {
  joinReasoningRoles,
  resolvePersistedReasoning,
} from "@/lib/pipeline/verification/reasoning-join";

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

/**
 * The emitting-side round trip — the test that turns the marker seam from a
 * coincidence into a contract.
 *
 * `verdict-glossary.test.ts` already asserts the prose glossary is a no-op on
 * each role-marker literal, from the display side. This is the mirror: the
 * PIPELINE's join (`lib/pipeline/verification/reasoning-join.ts`) duplicates
 * these three literals by construction, because `lib/**` may not import
 * `app/**` — enforced both by `tests/architecture.test.ts` and by the ESLint
 * `no-restricted-imports` rule. The reverse direction, `app` → `lib`, is
 * allowed, so the assertion lives here and the two copies cannot drift apart
 * without going red.
 *
 * The deep import is legal in an app TEST file: the architecture test's
 * app-source scan filters out `*.test.ts` before applying the runtime-import
 * allowlist (`tests/architecture.test.ts`, the `appSourceFiles()` helper).
 * Do NOT add a fourth entry to that allowlist for it.
 */
describe("round trip against the pipeline's join", () => {
  const roles = {
    plain: "Die Formulierung passt zu den Belegen.",
    caveat: "die Studie betrachtet nur ein einzelnes Team.",
    technical: "Die Regel für Zahlenbefunde ist erfüllt.",
  };

  it("classifies a joined three-role reasoning as plain, caveat, technical", () => {
    expect(rolesOf(joinReasoningRoles(roles))).toEqual([
      "plain",
      "caveat",
      "technical",
    ]);
  });

  it("classifies a joined reasoning without a caveat as plain, technical", () => {
    expect(rolesOf(joinReasoningRoles({ ...roles, caveat: null }))).toEqual([
      "plain",
      "technical",
    ]);
  });

  it("carries a validated two-layer model answer all the way to the tiers", () => {
    // The last step of the phase's end-to-end crossing: what
    // `resolvePersistedReasoning` hands the register is what the card reads.
    const persisted = resolvePersistedReasoning({
      reasoning_plain: roles.plain,
      caveat: roles.caveat,
      reasoning_technical: roles.technical,
    });
    expect(rolesOf(persisted)).toEqual(["plain", "caveat", "technical"]);
  });

  it("leaves a single-reasoning (pre-v1.2.0) answer unmarked, as it renders today", () => {
    const persisted = resolvePersistedReasoning({
      reasoning: "Eine begutachtete Studie mit passendem Kontext liegt vor.",
    });
    expect(rolesOf(persisted)).toEqual(["unmarked"]);
  });
});
