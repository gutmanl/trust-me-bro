import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../../../register";
import exampleProject from "../../../register/schema/__fixtures__/example-project.json";
import { deriveReferenceScanState } from "./derive-state";

function baseRegister(): ClaimsRegister {
  const register = structuredClone(exampleProject) as unknown as ClaimsRegister;
  register.project_events = register.project_events.filter(
    (event) =>
      event.event !== "reference_scan_started" &&
      event.event !== "reference_scan_completed",
  );
  delete register.project.reference_scan;
  return register;
}

function withEvent(
  register: ClaimsRegister,
  event: "reference_scan_started" | "reference_scan_completed",
  seq: number,
  reason = "Test.",
): void {
  register.project_events.push({
    seq,
    at: `2026-08-07T0${seq}:00:00Z`,
    actor: "system:reference_scan",
    event,
    reason,
    prev_hash: "a".repeat(64),
    hash: "b".repeat(64),
  });
}

describe("deriveReferenceScanState", () => {
  it("reports not_started without any scan events", () => {
    const state = deriveReferenceScanState(baseRegister(), false);
    expect(state.status).toBe("not_started");
    expect(state.candidateCount).toBe(0);
  });

  it("reports running while a live run exists", () => {
    const register = baseRegister();
    withEvent(register, "reference_scan_started", 2);
    expect(deriveReferenceScanState(register, true).status).toBe("running");
  });

  it("reports interrupted for an unmatched start bracket", () => {
    const register = baseRegister();
    withEvent(register, "reference_scan_started", 2);
    expect(deriveReferenceScanState(register, false).status).toBe(
      "interrupted",
    );
  });

  it("reports completed once the bracket closes, carrying the pointer's candidate_count", () => {
    const register = baseRegister();
    withEvent(register, "reference_scan_started", 2);
    withEvent(register, "reference_scan_completed", 3, "3 Kandidaten.");
    register.project.reference_scan = {
      scanned_at: "2026-08-07T03:00:00Z",
      sha256: "c".repeat(64),
      blob_path: `blobs/${"c".repeat(2)}/${"c".repeat(64)}.json`,
      method: "regex",
      candidate_count: 3,
    };
    const state = deriveReferenceScanState(register, false);
    expect(state.status).toBe("completed");
    expect(state.reason).toBe("3 Kandidaten.");
    expect(state.candidateCount).toBe(3);
  });

  it("a rescan (retried bracket): the LAST bracket wins", () => {
    const register = baseRegister();
    withEvent(register, "reference_scan_started", 2);
    withEvent(register, "reference_scan_completed", 3, "Erster Scan.");
    withEvent(register, "reference_scan_started", 4);
    expect(deriveReferenceScanState(register, false).status).toBe(
      "interrupted",
    );
  });

  it("never reports a failed status even after a completed bracket", () => {
    const register = baseRegister();
    withEvent(register, "reference_scan_started", 2);
    withEvent(
      register,
      "reference_scan_completed",
      3,
      "Regex-Kanal degradiert.",
    );
    const state = deriveReferenceScanState(register, false);
    expect(state.status).toBe("completed");
  });
});
