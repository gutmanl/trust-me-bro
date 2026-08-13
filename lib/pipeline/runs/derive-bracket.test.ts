import { describe, expect, it } from "vitest";

import type { ProjectEvent } from "../../register";
import { deriveRunBracket } from "./derive-bracket";

const event = (kind: ProjectEvent["event"], seq: number): ProjectEvent => ({
  seq,
  at: `2026-08-0${Math.min(seq, 9)}T08:00:00Z`,
  actor: "system:verification",
  event: kind,
  reason: `Ereignis ${seq}`,
  prev_hash: "0".repeat(64),
  hash: "1".repeat(64),
});

describe("deriveRunBracket", () => {
  it("reports not_started without any bracket events", () => {
    const bracket = deriveRunBracket(
      [event("batch_run_started", 1)],
      "verification_run_started",
      "verification_run_completed",
      false,
    );
    expect(bracket).toEqual({ phase: "not_started" });
  });

  it("reports running whenever a live run exists, with the last start", () => {
    const bracket = deriveRunBracket(
      [event("verification_run_started", 1)],
      "verification_run_started",
      "verification_run_completed",
      true,
    );
    expect(bracket.phase).toBe("running");
    expect(bracket).toMatchObject({ startedAt: "2026-08-01T08:00:00Z" });
  });

  it("reports interrupted for an open bracket without a close", () => {
    const bracket = deriveRunBracket(
      [
        event("verification_run_started", 1),
        event("verification_run_completed", 2),
        event("verification_run_started", 3),
      ],
      "verification_run_started",
      "verification_run_completed",
      false,
    );
    expect(bracket).toEqual({
      phase: "interrupted",
      startedAt: "2026-08-03T08:00:00Z",
    });
  });

  it("reports closed with the completion's timestamp and reason", () => {
    const bracket = deriveRunBracket(
      [
        event("verification_run_started", 1),
        event("verification_run_completed", 2),
      ],
      "verification_run_started",
      "verification_run_completed",
      false,
    );
    expect(bracket).toEqual({
      phase: "closed",
      startedAt: "2026-08-01T08:00:00Z",
      completedAt: "2026-08-02T08:00:00Z",
      reason: "Ereignis 2",
    });
  });

  it("treats a close after the last start as closed even with older opens", () => {
    const bracket = deriveRunBracket(
      [
        event("verification_run_started", 1),
        event("verification_run_started", 2),
        event("verification_run_completed", 3),
      ],
      "verification_run_started",
      "verification_run_completed",
      false,
    );
    expect(bracket.phase).toBe("closed");
  });
});
