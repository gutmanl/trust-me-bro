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

describe("autoConfirmableWithoutPriorHumanConfirmation (prechecked → auto_confirmed)", () => {
  const gate = gateFor("prechecked", "auto_confirmed");
  const inverse = gateFor("prechecked", "pending_adjudication");

  /** A claim whose machine verdict is clean: supported, licensed, and with
   * no divergence among the latest judgments per backend. */
  function cleanVerdict(history: HistoryEntry[]): Claim {
    return claim({
      status: "prechecked",
      support_degree: "supported",
      calibration_result: "licensed",
      evidence: [
        {
          id: "ev_0001",
          source_id: "src_0001",
          locator: { page: 1 },
          verbatim_excerpt: "Reviewzeit sank",
          relation_type: "supports",
          judgments: [
            {
              backend: "claude",
              model: "test",
              relation_type: "supports",
              confidence: 0.9,
              reasoning: "Deckt sich mit dem Auszug.",
              at: "2026-08-24T10:00:00Z",
            },
          ],
        },
      ],
      history,
    } as Partial<Claim> & { status: ClaimStatus });
  }

  const priorHumanConfirmation = entry({
    seq: 2,
    from_status: "pending_adjudication",
    to_status: "confirmed",
    actor: "human:lg",
    reason: "Bestätigt.",
    decision: { categories: [], reviewed_evidence_ids: [], duration_s: 12 },
  });

  it("admits a clean machine verdict on a claim no human ever confirmed", () => {
    expect(gate(cleanVerdict([entry({ seq: 1 })]))).toEqual({ ok: true });
  });

  it("refuses a clean machine verdict on a claim a human already confirmed", () => {
    // SC4: the claim was pulled back for a re-run and its fresh verdict is
    // clean. The machine must NOT re-confirm what the reviewer decided.
    const result = gate(
      cleanVerdict([entry({ seq: 1 }), priorHumanConfirmation]),
    );
    expect(result.ok).toBe(false);
  });

  it("gives the human-confirmation refusal a reason distinct from the machine-verdict ones", () => {
    // The German transition reason interpolates this string verbatim, so a
    // reader must be able to tell "the verdict was not clean" from "a human
    // already decided this". evaluateAutoConfirmation's three reasons name
    // support_degree, calibration_result or divergence; this one names
    // neither, and names the confirming actor instead.
    const result = gate(
      cleanVerdict([entry({ seq: 1 }), priorHumanConfirmation]),
    );
    const reason = result.ok === false ? result.reason : "";
    expect(reason).toContain("human:lg");
    expect(reason).toContain("returns to the reviewer");
    for (const machineReason of [
      "support_degree",
      "calibration_result",
      "diverge",
    ]) {
      expect(reason).not.toContain(machineReason);
    }
  });

  it("does not strand the claim: the adjudication edge admits exactly what this one refuses", () => {
    // The two gates must stay exact complements. A human-confirmed claim
    // with a clean verdict is the case that would otherwise sit in
    // prechecked with no takeable outgoing edge at all.
    const humanConfirmed = cleanVerdict([
      entry({ seq: 1 }),
      priorHumanConfirmation,
    ]);
    expect(gate(humanConfirmed).ok).toBe(false);
    expect(inverse(humanConfirmed)).toEqual({ ok: true });

    const fresh = cleanVerdict([entry({ seq: 1 })]);
    expect(gate(fresh).ok).toBe(true);
    expect(inverse(fresh).ok).toBe(false);
  });

  it("ignores a SYSTEM confirmation — only a human decision closes the edge", () => {
    // Warm-run adoption creates a claim directly into `confirmed` under a
    // system actor. That is a machine determination carried over, not a
    // reviewer's decision, and must not permanently disqualify the claim.
    const adopted = cleanVerdict([
      entry({
        seq: 1,
        to_status: "confirmed",
        actor: "system:adoption",
        reason: "Aus Vorprojekt übernommen.",
      }),
    ]);
    expect(gate(adopted)).toEqual({ ok: true });
  });
});
