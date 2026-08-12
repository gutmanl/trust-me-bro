import { describe, expect, it } from "vitest";

import { createRunDoneLatch } from "../app/lib/useRunFeed";

/**
 * The panel-side terminal-event latch of the unified event stream (workbench
 * epic). A panel becomes `watching` from its start action's RESPONSE, so a
 * short run can be over before that response commits — reference capture in
 * particular finishes a cached or instantly-failing batch in milliseconds.
 * Firing onDone only on the terminal event therefore left the panel stuck on
 * "Wird erfasst …" forever; the deleted per-feature capture route had papered
 * over exactly this by replaying a finished run's log.
 *
 * app/** is outside the coverage gate; this test is here for correctness,
 * not for the ratio.
 */

describe("createRunDoneLatch", () => {
  it("reports a terminal event that arrives while the panel is watching", () => {
    const latch = createRunDoneLatch();
    expect(latch.terminated("run-1", true)).toBe(true);
    // Already delivered: settling `active` again must not fire a second time.
    expect(latch.watched(true)).toBe(false);
  });

  it("holds a terminal event that arrives BEFORE the panel starts watching", () => {
    const latch = createRunDoneLatch();
    // The run ends while the start action's response is still in flight.
    expect(latch.terminated("run-1", false)).toBe(false);
    // …and the panel flips to watching afterwards: this is the stuck-panel
    // case, and the latch pays the debt here.
    expect(latch.watched(true)).toBe(true);
    expect(latch.watched(true)).toBe(false);
  });

  it("never fires while the panel is not watching", () => {
    const latch = createRunDoneLatch();
    latch.terminated("run-1", false);
    expect(latch.watched(false)).toBe(false);
    // Still owed once the panel does start watching.
    expect(latch.watched(true)).toBe(true);
  });

  it("owes one onDone per run, not per active flip", () => {
    const latch = createRunDoneLatch();
    expect(latch.terminated("run-1", true)).toBe(true);
    expect(latch.watched(false)).toBe(false);
    expect(latch.watched(true)).toBe(false);

    // A second run of the same kind is a new debt (the auto-chain case).
    expect(latch.terminated("run-2", false)).toBe(false);
    expect(latch.watched(true)).toBe(true);
    expect(latch.watched(true)).toBe(false);
  });

  it("does not re-fire for a run already reported, even out of order", () => {
    const latch = createRunDoneLatch();
    expect(latch.terminated("run-1", true)).toBe(true);
    // A duplicate terminal envelope for the same run (a reconnect replay
    // carrying the run's whole log again) is not a second completion.
    expect(latch.terminated("run-1", true)).toBe(false);
    expect(latch.watched(true)).toBe(false);
  });
});
