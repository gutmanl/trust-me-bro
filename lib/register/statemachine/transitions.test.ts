/**
 * Gate-level tests of the transition table. Deliberately store-free: these
 * assert the pure predicates a gate applies to an already-persisted claim,
 * copying the shape of the behavioural guards in tests/architecture.test.ts
 * (direct assertions over TRANSITIONS, no RegisterStore). The store-backed
 * integration walk lives in statemachine.test.ts.
 *
 * These exist because tests/architecture.test.ts pins edges as
 * `{from, to, actorKind, decision}` and carries NO `gate` key: a gate change
 * is invisible to the binding guard. The cases below are the compensating
 * pin.
 */
import { describe, expect, it } from "vitest";

import type { Claim } from "../schema/claim";
import type { ClaimStatus } from "../schema/enums";
import type { HistoryEntry } from "../schema/history";
import { findTransition } from "./transitions";

const HASH = "a".repeat(64);

function entry(
  overrides: Partial<HistoryEntry> & { seq: number },
): HistoryEntry {
  return {
    at: "2026-08-24T10:00:00Z",
    actor: "system:extraction",
    from_status: null,
    to_status: "captured",
    reason: "Testeintrag.",
    prev_hash: HASH,
    hash: HASH,
    ...overrides,
  } as HistoryEntry;
}

function claim(overrides: Partial<Claim> & { status: ClaimStatus }): Claim {
  return {
    id: "clm_0001",
    text: "Die Reviewzeit sank messbar.",
    claim_type: "quantitative_finding",
    briefing_anchor: "p1",
    provenance: {
      tool: "test",
      model: "test",
      extracted_at: "2026-08-24T09:00:00Z",
      search_path: "Test",
    },
    evidence: [],
    history: [entry({ seq: 1 })],
    ...overrides,
  } as Claim;
}

/** The gate under test, read off the table rather than imported, so a test
 * cannot pass against a predicate the table no longer uses. */
function gateFor(
  from: ClaimStatus | null,
  to: ClaimStatus,
  actorKind: "system" | "human" = "system",
) {
  const def = findTransition(from, to, actorKind);
  if (!def) {
    throw new Error(`no ${String(from)} → ${to} (${actorKind}) edge`);
  }
  return def.gate;
}

describe("machineParkedInAdjudication (pending_adjudication → recheck_required)", () => {
  const gate = gateFor("pending_adjudication", "recheck_required");

  it("admits a claim whose latest entry carries ANY structured routing reason", () => {
    // The widening: before the reviewer-triggered re-verification only
    // existence_check_failed was admitted. All four of these are machine
    // routings and none was reachable before.
    for (const routing of [
      "existence_check_failed",
      "divergence",
      "negative_precheck",
      "spot_check",
    ] as const) {
      const result = gate(
        claim({
          status: "pending_adjudication",
          history: [
            entry({ seq: 1 }),
            entry({
              seq: 2,
              from_status: "prechecked",
              to_status: "pending_adjudication",
              actor: "system:precheck",
              routing,
            }),
          ],
        }),
      );
      expect(result, `routing ${routing} must be admitted`).toEqual({
        ok: true,
      });
    }
  });

  it("refuses a machine-parked claim whose latest entry carries no routing (P-20)", () => {
    // RoutingReason is itself a documented extension; an entry written
    // before it simply lacks the field. Such a claim WAS machine-parked and
    // is nonetheless rejected — the gate's stated blind spot, pinned here so
    // it stays a known exclusion rather than a silent one.
    const result = gate(
      claim({
        status: "pending_adjudication",
        history: [
          entry({ seq: 1 }),
          entry({
            seq: 2,
            from_status: "prechecked",
            to_status: "pending_adjudication",
            actor: "system:precheck",
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      "no structured routing reason",
    );
  });

  it("refuses a claim whose latest entry is a human decision", () => {
    // The soundness argument in one assertion: no human edge targets
    // pending_adjudication, so a human entry is never a routing entry, and
    // "carries a routing reason" therefore means "no human has acted since".
    const result = gate(
      claim({
        status: "pending_adjudication",
        history: [
          entry({ seq: 1 }),
          entry({
            seq: 2,
            from_status: "prechecked",
            to_status: "pending_adjudication",
            actor: "system:precheck",
            routing: "negative_precheck",
          }),
          entry({
            seq: 3,
            from_status: "pending_adjudication",
            to_status: "confirmed",
            actor: "human:lg",
            reason: "Bestätigt.",
            decision: {
              categories: [],
              reviewed_evidence_ids: [],
              duration_s: 12,
            },
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });
});
