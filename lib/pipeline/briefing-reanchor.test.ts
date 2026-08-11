import { describe, expect, it } from "vitest";

import { computeReanchorUpdates } from "./briefing-reanchor";

function claim(overrides: {
  id: string;
  briefing_anchor: string;
  anchor_quote?: string;
}) {
  return overrides;
}

describe("computeReanchorUpdates", () => {
  it("skips legacy claims without anchor_quote", () => {
    const updates = computeReanchorUpdates(
      ["Para eins.", "Para zwei."],
      [claim({ id: "clm_0001", briefing_anchor: "p1" })],
    );
    expect(updates).toEqual([]);
  });

  it("emits nothing when the hinted paragraph still contains the quote", () => {
    const updates = computeReanchorUpdates(
      ["Para eins.", "Die Reviewzeit sinkt deutlich."],
      [
        claim({
          id: "clm_0001",
          briefing_anchor: "p2",
          anchor_quote: "Die Reviewzeit sinkt deutlich.",
        }),
      ],
    );
    expect(updates).toEqual([]);
  });

  it("emits an update when the quote moved to a different paragraph", () => {
    const updates = computeReanchorUpdates(
      [
        "Para eins.",
        "Neuer Absatz dazwischen.",
        "Die Reviewzeit sinkt deutlich.",
      ],
      [
        claim({
          id: "clm_0001",
          briefing_anchor: "p2",
          anchor_quote: "Die Reviewzeit sinkt deutlich.",
        }),
      ],
    );
    expect(updates).toEqual([
      {
        claimId: "clm_0001",
        anchor: "p3",
        quote: "Die Reviewzeit sinkt deutlich.",
      },
    ]);
  });

  it("finds the quote via full scan when the hint no longer contains it", () => {
    // Anchor hint p1 no longer holds the quote (paragraph reordered); the
    // quote is now the sole occurrence in paragraph 2.
    const updates = computeReanchorUpdates(
      ["Ganz anderer Text.", "Die Reviewzeit sinkt deutlich."],
      [
        claim({
          id: "clm_0001",
          briefing_anchor: "p1",
          anchor_quote: "Die Reviewzeit sinkt deutlich.",
        }),
      ],
    );
    expect(updates).toEqual([
      {
        claimId: "clm_0001",
        anchor: "p2",
        quote: "Die Reviewzeit sinkt deutlich.",
      },
    ]);
  });

  it("emits nothing when the quote is not found anywhere (stale anchor kept)", () => {
    const updates = computeReanchorUpdates(
      ["Para eins.", "Para zwei, komplett neu geschrieben."],
      [
        claim({
          id: "clm_0001",
          briefing_anchor: "p2",
          anchor_quote: "Die Reviewzeit sinkt deutlich.",
        }),
      ],
    );
    expect(updates).toEqual([]);
  });

  it("tolerates an out-of-range or unparsable hint by falling straight to the scan", () => {
    const updates = computeReanchorUpdates(
      ["Die Reviewzeit sinkt deutlich."],
      [
        claim({
          id: "clm_0001",
          briefing_anchor: "p9",
          anchor_quote: "Die Reviewzeit sinkt deutlich.",
        }),
        claim({
          id: "clm_0002",
          briefing_anchor: "not-a-valid-anchor",
          anchor_quote: "Die Reviewzeit sinkt deutlich.",
        }),
      ],
    );
    expect(updates).toEqual([
      {
        claimId: "clm_0001",
        anchor: "p1",
        quote: "Die Reviewzeit sinkt deutlich.",
      },
      {
        claimId: "clm_0002",
        anchor: "p1",
        quote: "Die Reviewzeit sinkt deutlich.",
      },
    ]);
  });
});
