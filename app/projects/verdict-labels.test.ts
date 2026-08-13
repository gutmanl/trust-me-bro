import { describe, expect, it } from "vitest";

import type { CalibrationResult, SupportDegree } from "@/lib/register";
import {
  deriveVerdict,
  relationBadgeClassName,
  verdictBadgeClassName,
} from "./verdict-labels";

const SUPPORT: SupportDegree[] = [
  "supported",
  "partially_supported",
  "uncertain",
  "unsupported",
];
const CALIBRATION: CalibrationResult[] = [
  "licensed",
  "weakened",
  "pending_adjudication",
];

describe("deriveVerdict", () => {
  it("covers every support × calibration cell with a phrase and severity", () => {
    for (const support of SUPPORT) {
      for (const calibration of CALIBRATION) {
        const verdict = deriveVerdict(support, calibration, false);
        expect(verdict?.phrase.length).toBeGreaterThan(0);
        expect(verdictBadgeClassName(verdict!.severity)).toMatch(/^bg-/);
      }
    }
  });

  it("maps the key cells to the intended phrasing and severity", () => {
    expect(deriveVerdict("supported", "licensed", false)).toEqual({
      phrase: "stützt",
      severity: "green",
    });
    expect(deriveVerdict("supported", "weakened", false)).toEqual({
      phrase: "stützt, aber zu stark formuliert",
      severity: "amber",
    });
    expect(deriveVerdict("partially_supported", "licensed", false)).toEqual({
      phrase: "stützt teilweise",
      severity: "amber",
    });
    expect(deriveVerdict("partially_supported", "weakened", false)).toEqual({
      phrase: "stützt nicht in diesem Ausmaß",
      severity: "orange",
    });
    expect(deriveVerdict("unsupported", "weakened", false)).toEqual({
      phrase: "stützt nicht",
      severity: "red",
    });
    expect(deriveVerdict("uncertain", "pending_adjudication", false)).toEqual({
      phrase: "unklar",
      severity: "orange",
    });
  });

  it("reports divergence as its own red verdict, whatever the enums say", () => {
    expect(deriveVerdict(undefined, undefined, true)).toEqual({
      phrase: "Backend-Urteile widersprüchlich",
      severity: "red",
    });
  });

  it("hides the badge before the pre-check produced anything", () => {
    expect(deriveVerdict(undefined, undefined, false)).toBeNull();
  });

  it("degrades visibly on an asymmetric (invariant-violating) state", () => {
    expect(deriveVerdict("supported", undefined, false)).toEqual({
      phrase: "Vorprüfung unvollständig",
      severity: "slate",
    });
    expect(deriveVerdict(undefined, "licensed", false)?.severity).toBe("slate");
  });
});

describe("relationBadgeClassName", () => {
  it("maps each relation to its severity color", () => {
    expect(relationBadgeClassName("supports")).toContain("green");
    expect(relationBadgeClassName("partially_supports")).toContain("amber");
    expect(relationBadgeClassName("contradicts")).toContain("red");
    expect(relationBadgeClassName("not_relevant")).toContain("slate");
  });
});
