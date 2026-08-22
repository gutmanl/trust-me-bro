import { describe, expect, it } from "vitest";

import {
  joinReasoningRoles,
  resolvePersistedReasoning,
} from "./reasoning-join";

/**
 * The BYTE-level half of the marker contract (PROMPT-03). The round trip in
 * `app/projects/reasoning-paragraphs.test.ts` proves the SEAM against the
 * app-tier classifier; this file proves the BYTES. One without the other
 * leaves either side free to drift into agreement on the wrong thing —
 * a classifier and a join that both moved to `Einfach:` would round-trip
 * perfectly and silently demote every stored reasoning.
 *
 * The marker literals are therefore asserted AS LITERALS here, on purpose.
 */

const ROLES = {
  plain: "Die Formulierung passt zu den Belegen.",
  caveat: "nur eine Quelle.",
  technical: "Die Regel für Zahlenbefunde ist erfüllt.",
} as const;

describe("joinReasoningRoles", () => {
  it("separates paragraphs by exactly two line feeds", () => {
    const joined = joinReasoningRoles(ROLES);
    expect(joined.split("\n\n")).toHaveLength(3);
    expect(joined).not.toMatch(/\n{3,}/);
  });

  it.each([
    ["plain", "Einfach gesagt: "],
    ["caveat", "Jedoch: "],
    ["technical", "Technisch: "],
  ])(
    "prefixes the %s paragraph with its exact marker literal",
    (_role, marker) => {
      const paragraphs = joinReasoningRoles(ROLES).split("\n\n");
      expect(paragraphs.some((paragraph) => paragraph.startsWith(marker))).toBe(
        true,
      );
    },
  );

  it("emits the roles in the order plain, caveat, technical", () => {
    expect(joinReasoningRoles(ROLES)).toBe(
      `Einfach gesagt: ${ROLES.plain}\n\n` +
        `Jedoch: ${ROLES.caveat}\n\n` +
        `Technisch: ${ROLES.technical}`,
    );
  });

  it("omits the caveat paragraph entirely when there is no caveat", () => {
    // Never a bare `Jedoch: ` — that renders an empty amber rule.
    const joined = joinReasoningRoles({ ...ROLES, caveat: null });
    expect(joined.split("\n\n")).toHaveLength(2);
    expect(joined).not.toContain("Jedoch:");
    expect(joined).toBe(
      `Einfach gesagt: ${ROLES.plain}\n\nTechnisch: ${ROLES.technical}`,
    );
  });
});

describe("resolvePersistedReasoning", () => {
  it("hands back a single-reasoning output's own string unchanged", () => {
    const reasoning = "Die Mindestbelege des Bewertungsschemas liegen vor.";
    expect(resolvePersistedReasoning({ reasoning })).toBe(reasoning);
  });

  it("joins a two-layer output into the persisted string", () => {
    expect(
      resolvePersistedReasoning({
        reasoning_plain: ROLES.plain,
        caveat: ROLES.caveat,
        reasoning_technical: ROLES.technical,
      }),
    ).toBe(joinReasoningRoles(ROLES));
  });
});
