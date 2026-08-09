import { describe, expect, it } from "vitest";

import type { ClaimsRegister, ClaimStatus } from "../../register";
import exampleProject from "../../register/schema/__fixtures__/example-project.json";
import { pickUnfinishedClaims } from "./select-claims";

function registerWithStatuses(statuses: ClaimStatus[]): ClaimsRegister {
  const register = structuredClone(exampleProject) as unknown as ClaimsRegister;
  const template = register.claims[0];
  register.claims = statuses.map((status, index) => ({
    ...structuredClone(template),
    id: `clm_${String(index + 1).padStart(4, "0")}`,
    status,
  }));
  return register;
}

describe("pickUnfinishedClaims", () => {
  it("selects captured and existence_checked claims in register order", () => {
    const register = registerWithStatuses([
      "captured",
      "confirmed",
      "existence_checked",
      "pending_adjudication",
      "auto_confirmed",
      "prechecked",
      "discarded",
      "captured",
    ]);
    expect(pickUnfinishedClaims(register).map((claim) => claim.id)).toEqual([
      "clm_0001",
      "clm_0003",
      "clm_0008",
    ]);
  });

  it("returns an empty list when nothing remains", () => {
    expect(
      pickUnfinishedClaims(registerWithStatuses(["confirmed", "discarded"])),
    ).toEqual([]);
  });
});
