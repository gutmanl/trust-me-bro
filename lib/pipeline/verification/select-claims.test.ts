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
  it("selects erfasst and existenzgeprueft claims in register order", () => {
    const register = registerWithStatuses([
      "erfasst",
      "bestaetigt",
      "existenzgeprueft",
      "zur_adjudikation",
      "automatisch_bestaetigt",
      "vorgeprueft",
      "verworfen",
      "erfasst",
    ]);
    expect(pickUnfinishedClaims(register).map((claim) => claim.id)).toEqual([
      "clm_0001",
      "clm_0003",
      "clm_0008",
    ]);
  });

  it("returns an empty list when nothing remains", () => {
    expect(
      pickUnfinishedClaims(registerWithStatuses(["bestaetigt", "verworfen"])),
    ).toEqual([]);
  });
});
