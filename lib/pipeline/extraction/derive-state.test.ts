import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../../register";
import exampleProject from "../../register/schema/__fixtures__/example-project.json";
import { deriveExtractionState } from "./derive-state";

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

function withEvent(
  register: ClaimsRegister,
  event: "batch_run_started" | "batch_run_completed",
  seq: number,
  reason = "Test.",
): void {
  register.project_events.push({
    seq,
    at: `2026-08-07T0${seq}:00:00Z`,
    actor: "system:extraction",
    event,
    reason,
    prev_hash: "a".repeat(64),
    hash: "b".repeat(64),
  });
}

describe("deriveExtractionState", () => {
  it("reports not_started without any batch events", () => {
    expect(deriveExtractionState(baseRegister(), false).status).toBe(
      "not_started",
    );
  });

  it("reports running while a live run exists", () => {
    const register = baseRegister();
    withEvent(register, "batch_run_started", 2);
    expect(deriveExtractionState(register, true).status).toBe("running");
  });

  it("reports interrupted for an unmatched start bracket", () => {
    const register = baseRegister();
    withEvent(register, "batch_run_started", 2);
    expect(deriveExtractionState(register, false).status).toBe("interrupted");
  });

  it("reports failed for a completed run without claims", () => {
    const register = baseRegister();
    withEvent(register, "batch_run_started", 2);
    withEvent(register, "batch_run_completed", 3, "Erschöpft.");
    const state = deriveExtractionState(register, false);
    expect(state.status).toBe("failed");
    expect(state.reason).toBe("Erschöpft.");
  });

  it("reports completed once claims exist under a closed bracket", () => {
    const register = baseRegister();
    withEvent(register, "batch_run_started", 2);
    withEvent(register, "batch_run_completed", 3, "2 Claims.");
    register.claims = (
      structuredClone(exampleProject) as unknown as ClaimsRegister
    ).claims;
    const state = deriveExtractionState(register, false);
    expect(state.status).toBe("completed");
    expect(state.totalClaims).toBe(1);
  });

  it("a retried run: the LAST bracket wins", () => {
    const register = baseRegister();
    withEvent(register, "batch_run_started", 2);
    withEvent(register, "batch_run_completed", 3, "Fehlschlag.");
    withEvent(register, "batch_run_started", 4);
    expect(deriveExtractionState(register, false).status).toBe("interrupted");
  });
});
