import { describe, expect, it } from "vitest";

import type { ClaimsRegister, ClaimStatus, ProjectEvent } from "../../register";
import exampleProject from "../../register/schema/__fixtures__/example-project.json";
import { deriveVerificationState } from "./derive-state";

function makeRegister(options: {
  statuses?: ClaimStatus[];
  events?: Array<{ event: ProjectEvent["event"]; seq: number }>;
}): ClaimsRegister {
  const register = structuredClone(exampleProject) as unknown as ClaimsRegister;
  const template = register.claims[0];
  register.claims = (options.statuses ?? []).map((status, index) => ({
    ...structuredClone(template),
    id: `clm_${String(index + 1).padStart(4, "0")}`,
    status,
  }));
  register.project_events = (options.events ?? []).map(({ event, seq }) => ({
    seq,
    at: `2026-08-0${Math.min(seq, 9)}T08:00:00Z`,
    actor: "system:verification",
    event,
    reason: `Ereignis ${seq}`,
    prev_hash: "0".repeat(64),
    hash: "1".repeat(64),
  }));
  return register;
}

describe("deriveVerificationState", () => {
  it("reports nicht_gestartet without any verification events", () => {
    const state = deriveVerificationState(
      makeRegister({
        statuses: ["erfasst"],
        events: [{ event: "batch_run_started", seq: 1 }],
      }),
      false,
    );
    expect(state).toMatchObject({ status: "nicht_gestartet", openClaims: 1 });
  });

  it("reports laeuft while a live verification run exists", () => {
    const state = deriveVerificationState(
      makeRegister({
        statuses: ["erfasst"],
        events: [{ event: "verification_run_started", seq: 1 }],
      }),
      true,
    );
    expect(state.status).toBe("laeuft");
  });

  it("reports unterbrochen for a start bracket without completion", () => {
    const state = deriveVerificationState(
      makeRegister({
        statuses: ["existenzgeprueft"],
        events: [{ event: "verification_run_started", seq: 1 }],
      }),
      false,
    );
    expect(state).toMatchObject({ status: "unterbrochen", openClaims: 1 });
  });

  it("derives angehalten vs abgeschlossen from remaining claims, not event text", () => {
    const events: Array<{ event: ProjectEvent["event"]; seq: number }> = [
      { event: "verification_run_started", seq: 1 },
      { event: "verification_run_completed", seq: 2 },
    ];
    expect(
      deriveVerificationState(
        makeRegister({ statuses: ["existenzgeprueft"], events }),
        false,
      ).status,
    ).toBe("angehalten");
    expect(
      deriveVerificationState(
        makeRegister({ statuses: ["automatisch_bestaetigt"], events }),
        false,
      ).status,
    ).toBe("abgeschlossen");
  });

  it("ignores extraction batch events entirely", () => {
    const state = deriveVerificationState(
      makeRegister({
        statuses: ["automatisch_bestaetigt"],
        events: [
          { event: "batch_run_started", seq: 1 },
          { event: "batch_run_completed", seq: 2 },
        ],
      }),
      false,
    );
    expect(state.status).toBe("nicht_gestartet");
  });
});
