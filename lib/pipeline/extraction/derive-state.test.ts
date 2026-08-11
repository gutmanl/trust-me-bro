import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../../register";
import exampleProject from "../../register/schema/__fixtures__/example-project.json";
import {
  deriveExtractionActivity,
  EXTRACTION_COMPLETED_PREFIX,
  EXTRACTION_FAILED_PREFIX,
} from "./derive-state";

function baseRegister(): ClaimsRegister {
  const register = structuredClone(exampleProject) as unknown as ClaimsRegister;
  register.claims = [];
  register.project_events = register.project_events.filter(
    (event) =>
      event.event !== "batch_run_started" &&
      event.event !== "batch_run_completed",
  );
  return register;
}

function withCompletion(register: ClaimsRegister, reason: string): void {
  register.project_events.push({
    seq: register.project_events.length + 1,
    at: "2026-08-11T09:00:00Z",
    actor: "system:extraction",
    event: "batch_run_completed",
    reason,
    prev_hash: "a".repeat(64),
    hash: "b".repeat(64),
  });
}

describe("deriveExtractionActivity", () => {
  it("reports no outcome before any pass ran", () => {
    expect(deriveExtractionActivity(baseRegister(), false)).toEqual({
      running: false,
      lastOutcome: null,
      lastMessage: null,
    });
  });

  it("reports a live pass from the runner, not from the register", () => {
    expect(deriveExtractionActivity(baseRegister(), true).running).toBe(true);
  });

  it("reads a committed pass off its completion reason", () => {
    const register = baseRegister();
    withCompletion(
      register,
      `${EXTRACTION_COMPLETED_PREFIX} (Quelle src_a, Lauf 1): 2 neue(r) Claim(s).`,
    );
    const activity = deriveExtractionActivity(register, false);
    expect(activity.lastOutcome).toBe("completed");
    expect(activity.lastMessage).toContain("Quelle src_a");
  });

  it("recognizes a pass that produced nothing", () => {
    const register = baseRegister();
    withCompletion(register, `${EXTRACTION_FAILED_PREFIX} beendet: erschöpft.`);
    expect(deriveExtractionActivity(register, false).lastOutcome).toBe(
      "failed",
    );
  });

  it("the LAST pass wins — a successful retry clears the earlier failure", () => {
    const register = baseRegister();
    withCompletion(register, `${EXTRACTION_FAILED_PREFIX} beendet: erschöpft.`);
    withCompletion(register, `${EXTRACTION_COMPLETED_PREFIX} (Sweep, Lauf 2).`);
    expect(deriveExtractionActivity(register, false).lastOutcome).toBe(
      "completed",
    );
  });
});
