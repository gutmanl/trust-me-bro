import { describe, expect, it } from "vitest";

import { createActivityLedger } from "./activity-ledger";
import type { ActivityEntry } from "./activity-ledger";

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  let active = true;
  return {
    activityId: "a1",
    projectId: "p",
    source: "run",
    kind: "extraction",
    description: "Extraktion",
    startedAt: new Date().toISOString(),
    isActive: () => active,
    requestCancel: () => {
      active = false;
      return true;
    },
    ...overrides,
  };
}

describe("activity ledger", () => {
  it("registers, answers current, and deregisters", () => {
    const ledger = createActivityLedger();
    const unregister = ledger.register(entry());
    expect(ledger.current("p")?.activityId).toBe("a1");
    unregister();
    expect(ledger.current("p")).toBeUndefined();
  });

  it("refuses a second live occupant loudly — a collision is a bug", () => {
    const ledger = createActivityLedger();
    ledger.register(entry());
    expect(() =>
      ledger.register(entry({ activityId: "a2", source: "trigger" })),
    ).toThrow(/already occupied/);
  });

  it("self-heals on read: a dead entry that never deregistered stops blocking", () => {
    // The exact leak class this system fixes, one level down: even if a
    // registrant's cleanup is skipped, the seat frees itself as soon as the
    // activity flag drops.
    const ledger = createActivityLedger();
    let active = true;
    ledger.register(entry({ isActive: () => active }));
    expect(ledger.current("p")).toBeDefined();
    active = false;
    expect(ledger.current("p")).toBeUndefined();
    // And the seat is genuinely free for the next occupant.
    expect(() => ledger.register(entry({ activityId: "a2" }))).not.toThrow();
  });

  it("a stale deregistration cannot evict a successor", () => {
    const ledger = createActivityLedger();
    let firstActive = true;
    const unregisterFirst = ledger.register(
      entry({ isActive: () => firstActive }),
    );
    firstActive = false;
    ledger.register(entry({ activityId: "a2" }));
    unregisterFirst(); // late cleanup of the dead first occupant
    expect(ledger.current("p")?.activityId).toBe("a2");
  });
});
