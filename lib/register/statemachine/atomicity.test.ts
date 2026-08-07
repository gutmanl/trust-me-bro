import { describe, expect, it } from "vitest";

import { isAtomicClaimText } from "./atomicity";

describe("isAtomicClaimText", () => {
  it("accepts single declarative sentences", () => {
    expect(
      isAtomicClaimText(
        "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
      ),
    ).toBe(true);
    expect(isAtomicClaimText("Ohne Schlusspunkt formulierte Aussage")).toBe(
      true,
    );
  });

  it("tolerates decimals, ordinals, initials and abbreviations", () => {
    expect(isAtomicClaimText("Die Effektstärke lag bei 0.42 im Mittel.")).toBe(
      true,
    );
    expect(
      isAtomicClaimText("Seit dem 3. Quartal 2025 sinkt die Reviewzeit."),
    ).toBe(true);
    expect(isAtomicClaimText("A. Meyer zeigt eine Reduktion der Zeit.")).toBe(
      true,
    );
    expect(
      isAtomicClaimText(
        "Assistenten helfen bei Routineänderungen, z. B. Umbenennungen.",
      ),
    ).toBe(true);
    expect(
      isAtomicClaimText("Die Zeit sinkt bzw. Stagniert bei großen Diffs."),
    ).toBe(true);
  });

  it("flags bundled statements", () => {
    expect(
      isAtomicClaimText(
        "Die Reviewzeit sinkt um 55 %. Zudem steigt die Codequalität.",
      ),
    ).toBe(false);
    expect(
      isAtomicClaimText("Reviews werden schneller! Und die Qualität steigt."),
    ).toBe(false);
    expect(isAtomicClaimText("Sinkt die Zeit? Die Studie bejaht das.")).toBe(
      false,
    );
  });
});
