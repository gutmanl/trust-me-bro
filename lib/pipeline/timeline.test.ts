import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../register";
import { buildTimeline } from "./timeline";

const register = {
  claims: [
    {
      id: "clm_0001",
      history: [
        { seq: 2, to_status: "captured" },
        { seq: 5, to_status: "pending_adjudication" },
      ],
    },
    {
      id: "clm_0002",
      history: [{ seq: 3, to_status: "captured" }],
    },
  ],
  project_events: [
    { seq: 1, event: "project_created" },
    { seq: 4, event: "verification_run_started" },
  ],
} as unknown as ClaimsRegister;

describe("buildTimeline", () => {
  it("merges claim histories and project events ordered by seq", () => {
    const timeline = buildTimeline(register);
    expect(timeline.map((item) => item.entry.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(timeline.map((item) => item.kind)).toEqual([
      "project",
      "claim",
      "claim",
      "project",
      "claim",
    ]);
  });

  it("narrows to one claim's history without project events", () => {
    const timeline = buildTimeline(register, "clm_0001");
    expect(timeline).toHaveLength(2);
    expect(
      timeline.every(
        (item) => item.kind === "claim" && item.claimId === "clm_0001",
      ),
    ).toBe(true);
  });
});
