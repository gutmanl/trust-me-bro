import { describe, expect, it } from "vitest";

import type { ProjectEvent } from "../../register";
import { deriveOpenChainTriggers } from "./derive-brackets";
import { AUTO_CHAIN_ACTOR } from "./trigger-brackets";

let seq = 0;
function event(overrides: Partial<ProjectEvent>): ProjectEvent {
  seq += 1;
  return {
    seq,
    at: `2026-08-16T17:0${seq % 10}:00.000Z`,
    actor: AUTO_CHAIN_ACTOR,
    event: "batch_run_started",
    reason: "Test.",
    prev_hash: "0".repeat(64),
    hash: "0".repeat(64),
    state_root: "0".repeat(64),
    ...overrides,
  } as ProjectEvent;
}

describe("deriveOpenChainTriggers", () => {
  it("reads a start without a completion as open, per (kind, target)", () => {
    const open = deriveOpenChainTriggers([
      event({ trigger_kind: "source_repair_evaluation", source_id: "src_a" }),
      event({ trigger_kind: "source_repair_evaluation", source_id: "src_b" }),
      event({
        event: "batch_run_completed",
        trigger_kind: "source_repair_evaluation",
        source_id: "src_a",
      }),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: "source_repair_evaluation",
      sourceId: "src_b",
    });
  });

  it("a late (zombie) completion self-heals the derivation", () => {
    // Abandon leaves the bracket open; when the zombie settles and its
    // close lands after other work, the same read closes it — the one
    // mechanism for crash, cancel and timeout alike.
    const open = deriveOpenChainTriggers([
      event({ trigger_kind: "anchor_repair" }),
      event({ trigger_kind: "briefing_substitution", source_id: "src_a" }),
      event({ event: "batch_run_completed", trigger_kind: "anchor_repair" }),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0].kind).toBe("briefing_substitution");
  });

  it("a retry's newer start supersedes the older open bracket of the same target", () => {
    const open = deriveOpenChainTriggers([
      event({ trigger_kind: "capture_failure_repair", work_item_id: "wi_1" }),
      event({ trigger_kind: "capture_failure_repair", work_item_id: "wi_1" }),
      event({
        event: "batch_run_completed",
        trigger_kind: "capture_failure_repair",
        work_item_id: "wi_1",
      }),
    ]);
    expect(open).toHaveLength(0);
  });

  it("ignores extraction brackets (no trigger_kind) and other actors", () => {
    const open = deriveOpenChainTriggers([
      event({ actor: "system:extraction", source_id: "src_a" }),
      event({}),
    ]);
    expect(open).toHaveLength(0);
  });
});
