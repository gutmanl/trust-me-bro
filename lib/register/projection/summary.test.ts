import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../schema/register";
import exampleProject from "../schema/__fixtures__/example-project.json";
import { lastActivityAt } from "./activity";
import { countClaimsByStatus } from "./counts";

function baseRegister(): ClaimsRegister {
  return structuredClone(exampleProject) as unknown as ClaimsRegister;
}

describe("countClaimsByStatus", () => {
  it("returns a zeroed record for every status of the model", () => {
    const counts = countClaimsByStatus([]);
    expect(Object.values(counts)).toHaveLength(10);
    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
  });

  it("counts claims per status", () => {
    const register = baseRegister();
    const second = structuredClone(register.claims[0]);
    second.id = "clm_0002";
    second.status = "pending_adjudication";
    register.claims.push(second);

    const counts = countClaimsByStatus(register.claims);
    expect(counts.confirmed).toBe(1);
    expect(counts.pending_adjudication).toBe(1);
    expect(counts.captured).toBe(0);
  });
});

describe("lastActivityAt", () => {
  it("returns the timestamp of the highest-seq chain entry", () => {
    const register = baseRegister();
    const entries = [
      ...register.claims.flatMap((claim) => claim.history),
      ...register.project_events,
    ];
    const highest = entries.reduce((a, b) => (a.seq > b.seq ? a : b));
    expect(lastActivityAt(register)).toBe(highest.at);
  });

  it("is independent of entry ordering, not a timestamp maximum", () => {
    const register = baseRegister();
    // A lower-seq entry with a later timestamp must not win: backdated
    // entries are legal (at is caller-supplied), seq is the chain order.
    register.project_events[0].at = "2099-01-01T00:00:00Z";
    const highest = [
      ...register.claims.flatMap((claim) => claim.history),
      ...register.project_events,
    ].reduce((a, b) => (a.seq > b.seq ? a : b));
    expect(lastActivityAt(register)).toBe(highest.at);
  });

  it("falls back to created_at for a register without chain entries", () => {
    const register = baseRegister();
    register.claims = [];
    register.project_events = [];
    expect(lastActivityAt(register)).toBe(register.project.created_at);
  });
});
