import { describe, expect, it } from "vitest";

import type { ClaimType } from "@/lib/register";
import { CLAIM_TYPE_LABELS } from "./status-labels";

// Typed const array, mirroring verdict-labels.test.ts: a fifth claim type
// fails to COMPILE here instead of rendering as a blank or a raw token.
const CLAIM_TYPES: ClaimType[] = [
  "quantitative_finding",
  "comparative_statement",
  "effectiveness_statement",
  "recommendation",
];

describe("CLAIM_TYPE_LABELS", () => {
  it("labels every claim type in German", () => {
    for (const type of CLAIM_TYPES) {
      const label = CLAIM_TYPE_LABELS[type];
      expect(label.trim()).toBe(label);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("maps the four types to the intended German wording", () => {
    expect(CLAIM_TYPE_LABELS).toEqual({
      quantitative_finding: "quantitativer Befund",
      comparative_statement: "Vergleichsaussage",
      effectiveness_statement: "Wirksamkeitsaussage",
      recommendation: "Empfehlung",
    });
  });

  it("contains no raw enum token", () => {
    // Catches a half-done map where one entry was left as its key.
    for (const label of Object.values(CLAIM_TYPE_LABELS)) {
      expect(label).not.toContain("_");
    }
  });
});
