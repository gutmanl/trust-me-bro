import { describe, expect, it } from "vitest";

import type {
  CalibrationResult,
  CalibrationSnapshot,
  SupportDegree,
} from "@/lib/register";
import { deriveCalibrationSupersession } from "./calibration-supersession";

function snapshot(
  result: CalibrationResult,
  supersededAt: string,
  options: {
    supportDegree?: SupportDegree;
    reasoning?: string;
    promptVersion?: string;
  } = {},
): CalibrationSnapshot {
  return {
    support_degree: options.supportDegree ?? "supported",
    calibration_result: result,
    calibration_reasoning:
      options.reasoning ?? "Der Auszug trägt die Aussage in diesem Ausmaß.",
    calibration_prompt_version: options.promptVersion,
    superseded_at: supersededAt,
  };
}

describe("deriveCalibrationSupersession", () => {
  it("renders nothing when the claim has no archive", () => {
    // Render rule row 5: no placeholder, no zero state — null, not an object
    // carrying false flags that a caller could accidentally render.
    expect(deriveCalibrationSupersession(undefined, "licensed")).toBeNull();
  });

  it("renders nothing for an empty archive array", () => {
    expect(deriveCalibrationSupersession([], "licensed")).toBeNull();
  });

  it("renders nothing when the re-run reached the same conclusion", () => {
    // Render rule row 4, and the same judgment judgment-supersession.ts makes
    // when it skips a backend that repeated itself: a re-run that concluded
    // the same thing superseded nothing.
    expect(
      deriveCalibrationSupersession(
        [snapshot("licensed", "2026-08-21T09:00:00Z")],
        "licensed",
      ),
    ).toBeNull();
  });

  it("reports a changed verdict with the newest archived entry", () => {
    // Render rule row 1: line 1 alone — one archived entry never reaches the
    // depth threshold.
    const superseded = deriveCalibrationSupersession(
      [
        snapshot("licensed", "2026-08-21T09:00:00Z", {
          supportDegree: "supported",
          reasoning: "Der Auszug stützt die Aussage im behaupteten Ausmaß.",
          promptVersion: "1.0.0",
        }),
      ],
      "weakened",
    );
    expect(superseded).toEqual({
      previous: {
        support_degree: "supported",
        calibration_result: "licensed",
        calibration_reasoning:
          "Der Auszug stützt die Aussage im behaupteten Ausmaß.",
        calibration_prompt_version: "1.0.0",
        superseded_at: "2026-08-21T09:00:00Z",
      },
      changed: true,
      preCheckCount: 2,
      distinctResultCount: 2,
      showDepth: false,
    });
  });

  it("names the NEWEST archived entry, not the first", () => {
    const superseded = deriveCalibrationSupersession(
      [
        snapshot("licensed", "2026-08-21T09:00:00Z"),
        snapshot("weakened", "2026-08-22T09:00:00Z"),
      ],
      "pending_adjudication",
    );
    expect(superseded?.previous.calibration_result).toBe("weakened");
    expect(superseded?.previous.superseded_at).toBe("2026-08-22T09:00:00Z");
  });

  it("reports depth without a change when the archive moved and moved back", () => {
    // Render rule row 2 in isolation: the newest archived result equals the
    // current one, so no line 1 — but the claim has still produced two
    // different results across three pre-checks, which is the honest signal.
    const superseded = deriveCalibrationSupersession(
      [
        snapshot("weakened", "2026-08-21T09:00:00Z"),
        snapshot("licensed", "2026-08-22T09:00:00Z"),
      ],
      "licensed",
    );
    expect(superseded).not.toBeNull();
    expect(superseded?.changed).toBe(false);
    expect(superseded?.showDepth).toBe(true);
    expect(superseded?.preCheckCount).toBe(3);
    expect(superseded?.distinctResultCount).toBe(2);
  });

  it("reports both a change and depth together", () => {
    // Render rule row 3.
    const superseded = deriveCalibrationSupersession(
      [
        snapshot("licensed", "2026-08-21T09:00:00Z"),
        snapshot("weakened", "2026-08-22T09:00:00Z"),
      ],
      "licensed",
    );
    expect(superseded?.changed).toBe(true);
    expect(superseded?.showDepth).toBe(true);
    expect(superseded?.preCheckCount).toBe(3);
    expect(superseded?.distinctResultCount).toBe(2);
  });

  it("counts distinct RESULTS, not archived entries", () => {
    // Three archived entries, two distinct results: K is 2, not 3. Counting
    // entries instead of enum values would claim a claim produced three
    // different results when it produced two.
    const superseded = deriveCalibrationSupersession(
      [
        snapshot("licensed", "2026-08-21T09:00:00Z"),
        snapshot("weakened", "2026-08-22T09:00:00Z"),
        snapshot("licensed", "2026-08-23T09:00:00Z"),
      ],
      "weakened",
    );
    expect(superseded?.preCheckCount).toBe(4);
    expect(superseded?.distinctResultCount).toBe(2);
    expect(superseded?.showDepth).toBe(true);
  });

  it("counts all three distinct results when the archive produced all three", () => {
    const superseded = deriveCalibrationSupersession(
      [
        snapshot("licensed", "2026-08-21T09:00:00Z"),
        snapshot("weakened", "2026-08-22T09:00:00Z"),
        snapshot("pending_adjudication", "2026-08-23T09:00:00Z"),
      ],
      "licensed",
    );
    expect(superseded?.preCheckCount).toBe(4);
    expect(superseded?.distinctResultCount).toBe(3);
    expect(superseded?.showDepth).toBe(true);
  });

  it("passes an archived entry through with no support degree", () => {
    // `support_degree` is optional on the snapshot: an entry archived from a
    // register written before the degree was set carries none. The caller
    // must fall back to CALIBRATION_LABELS rather than render deriveVerdict's
    // „Vorprüfung unvollständig" degradation as if it were the old verdict.
    const superseded = deriveCalibrationSupersession(
      [
        {
          calibration_result: "licensed",
          calibration_reasoning: "Aus einem älteren Prüflauf.",
          superseded_at: "2026-08-21T09:00:00Z",
        },
      ],
      "weakened",
    );
    expect(superseded?.previous.support_degree).toBeUndefined();
    expect(superseded?.previous.calibration_result).toBe("licensed");
    expect(superseded?.changed).toBe(true);
  });

  it("renders nothing when the claim carries no current result", () => {
    // Unreachable through the pipeline — an entry is only archived BY a
    // calibration write. There is no current verdict to have changed from, so
    // a sentence naming one would describe a card state that does not exist.
    expect(
      deriveCalibrationSupersession(
        [snapshot("licensed", "2026-08-21T09:00:00Z")],
        undefined,
      ),
    ).toBeNull();
  });
});
