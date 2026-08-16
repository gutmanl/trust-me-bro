import { describe, expect, it } from "vitest";

import { createActivityLedger } from "./activity-ledger";
import { cancelActivity, describeBlockingActivity } from "./control";
import { formatActivitySince } from "./labels";

describe("formatActivitySince", () => {
  it("names only the time for a same-day start", () => {
    expect(formatActivitySince(new Date().toISOString())).toMatch(
      /^\d{2}:\d{2} Uhr$/,
    );
  });

  it("prefixes the date for an older start", () => {
    expect(formatActivitySince("2020-01-05T09:30:00.000Z")).toMatch(
      /^\d{2}\.\d{2}\., \d{2}:\d{2} Uhr$/,
    );
  });
});

describe("cancelActivity / describeBlockingActivity", () => {
  it("cancel with nothing running throws the no-active-run error", () => {
    const ledger = createActivityLedger();
    expect(() => cancelActivity("proj_leer", { ledger })).toThrow(/kein Lauf/);
  });

  it("describes nothing when the seat is free", () => {
    const ledger = createActivityLedger();
    expect(describeBlockingActivity("proj_leer", { ledger })).toBeUndefined();
  });
});
