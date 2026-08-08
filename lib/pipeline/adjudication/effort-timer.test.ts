import { describe, expect, it } from "vitest";

import { effortReducer, effortSeconds, startEffort } from "./effort-timer";

const T0 = 1_000_000;

describe("effort timer reducer", () => {
  it("accumulates active time between activity events", () => {
    let state = startEffort(T0);
    state = effortReducer(state, { type: "activity", at: T0 + 5_000 });
    state = effortReducer(state, { type: "activity", at: T0 + 12_000 });
    expect(effortSeconds(state, T0 + 12_000)).toBe(12);
  });

  it("caps idle gaps at the threshold (pause after inactivity)", () => {
    let state = startEffort(T0);
    // Five minutes without any activity: only the 30s threshold counts.
    state = effortReducer(state, { type: "activity", at: T0 + 300_000 });
    expect(effortSeconds(state, T0 + 300_000)).toBe(30);
  });

  it("does not count time while the document is hidden", () => {
    let state = startEffort(T0);
    state = effortReducer(state, { type: "hidden", at: T0 + 10_000 });
    state = effortReducer(state, { type: "visible", at: T0 + 100_000 });
    state = effortReducer(state, { type: "activity", at: T0 + 105_000 });
    // 10s before hiding + 5s after returning; the 90s hidden gap is free.
    expect(effortSeconds(state, T0 + 105_000)).toBe(15);
  });

  it("closes the open interval on the final read", () => {
    const state = startEffort(T0);
    expect(effortSeconds(state, T0 + 8_000)).toBe(8);
  });
});
