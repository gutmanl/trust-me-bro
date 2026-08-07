import { describe, expect, it } from "vitest";

import type { Claim, ClaimStatus, ProjectEvent } from "../../register";
import { drawSample, pendingSamplePopulation } from "./sample-draw";

const ids = ["clm_0001", "clm_0002", "clm_0003", "clm_0004", "clm_0005"];

function claimWith(
  id: string,
  status: ClaimStatus,
  confirmedAtSeq?: number,
): Claim {
  const history = [
    {
      seq: 1,
      at: "2026-08-01T08:00:00Z",
      actor: "system:extraction",
      from_status: null,
      to_status: "erfasst" as const,
      reason: "Test.",
      prev_hash: "0".repeat(64),
      hash: "1".repeat(64),
    },
  ];
  if (confirmedAtSeq !== undefined) {
    history.push({
      seq: confirmedAtSeq,
      at: "2026-08-02T08:00:00Z",
      actor: "system:vorpruefung",
      from_status: "vorgeprueft" as never,
      to_status: "automatisch_bestaetigt" as never,
      reason: "Test.",
      prev_hash: "0".repeat(64),
      hash: "1".repeat(64),
    });
  }
  return {
    id,
    text: "T.",
    claim_type: "quantitativer_einzelbefund",
    status,
    briefing_anchor: "p1",
    provenance: {
      tool: "t",
      model: "m",
      extracted_at: "2026-08-01T08:00:00Z",
      search_path: "s",
    },
    evidence: [],
    history,
  } as unknown as Claim;
}

function completedEvent(seq: number): ProjectEvent {
  return {
    seq,
    at: "2026-08-01T09:00:00Z",
    actor: "system:verification",
    event: "verification_run_completed",
    reason: "Test.",
    prev_hash: "0".repeat(64),
    hash: "1".repeat(64),
  };
}

describe("pendingSamplePopulation", () => {
  it("includes confirmations after the last closed bracket, excludes earlier ones", () => {
    const claims = [
      claimWith("clm_0001", "automatisch_bestaetigt", 5), // before last close
      claimWith("clm_0002", "automatisch_bestaetigt", 12), // stranded/current
      claimWith("clm_0003", "zur_adjudikation", 13), // no longer confirmed
      claimWith("clm_0004", "erfasst"),
    ];
    expect(pendingSamplePopulation(claims, [completedEvent(10)])).toEqual([
      "clm_0002",
    ]);
  });

  it("includes every confirmation when no bracket was ever closed", () => {
    const claims = [claimWith("clm_0001", "automatisch_bestaetigt", 3)];
    expect(pendingSamplePopulation(claims, [])).toEqual(["clm_0001"]);
  });
});

describe("drawSample", () => {
  it("draws nothing at rate 0 and everything at rate 1", () => {
    expect(drawSample(ids, 0, "run-a")).toEqual([]);
    expect(drawSample(ids, 1, "run-a")).toEqual([...ids].sort());
  });

  it("is reproducible for the same seed and differs across seeds", () => {
    const first = drawSample(ids, 0.5, "run-a");
    expect(drawSample(ids, 0.5, "run-a")).toEqual(first);
    const seeds = ["run-b", "run-c", "run-d", "run-e"];
    expect(
      seeds.some(
        (seed) =>
          JSON.stringify(drawSample(ids, 0.5, seed)) !== JSON.stringify(first),
      ),
    ).toBe(true);
  });

  it("is independent of the input collection order", () => {
    const shuffled = [ids[3], ids[0], ids[4], ids[2], ids[1]];
    expect(drawSample(shuffled, 0.5, "run-a")).toEqual(
      drawSample(ids, 0.5, "run-a"),
    );
  });

  it("pins the algorithm as part of the reproducibility contract", () => {
    // Regression pin: changing the PRNG or iteration scheme breaks
    // documented seeds of past runs (RQ3) and must be a conscious decision.
    expect(drawSample(ids, 0.5, "fixed-seed")).toEqual(["clm_0003"]);
  });
});
