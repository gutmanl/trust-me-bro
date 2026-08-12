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

  it("does not pay a stale completion once a NEWER run is under way", () => {
    // The interleaving that makes a naive latch flash "done" mid-run: run A
    // ends before the panel watches, run B starts, and `active` then flips
    // true for an unrelated reason — every terminal envelope of ANY kind
    // triggers a router.refresh(), which can re-render this panel into
    // watching while B is still running.
    const latch = createRunDoneLatch();
    expect(latch.terminated("run-A", false)).toBe(false);
    latch.observed("run-B");

    // A's completion is moot: the panel follows B now.
    expect(latch.watched(true)).toBe(false);
    // …and stays moot, however often `active` settles again.
    expect(latch.watched(true)).toBe(false);

    // B's own terminal event fires exactly once, through the normal path.
    expect(latch.terminated("run-B", true)).toBe(true);
    expect(latch.watched(true)).toBe(false);
  });

  it("still pays a stale completion when no newer run has been seen", () => {
    // Same shape as above minus the newer run — the original stuck-panel
    // bug must stay fixed.
    const latch = createRunDoneLatch();
    latch.observed("run-A");
    expect(latch.terminated("run-A", false)).toBe(false);
    expect(latch.watched(true)).toBe(true);
    expect(latch.watched(true)).toBe(false);
  });

  it("pays a newer run's completion after an unpaid older one", () => {
    // A ended unwatched, B ran and ended unwatched too: the debt that comes
    // due is B's, and only once.
    const latch = createRunDoneLatch();
    expect(latch.terminated("run-A", false)).toBe(false);
    latch.observed("run-B");
    expect(latch.terminated("run-B", false)).toBe(false);
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
