import { describe, expect, it } from "vitest";

import type { Judgment } from "../schema/evidence";
import type { HistoryEntry } from "../schema/history";
import {
  judgmentsForCurrentWording,
  resolveEvidenceRelation,
} from "./divergence";

type HistorySlice = Pick<HistoryEntry, "to_status" | "at">;

const judgment = (
  backend: string,
  relation: Judgment["relation_type"],
  at: string,
): Judgment => ({
  backend,
  model: "test-model",
  relation_type: relation,
  confidence: 0.9,
  reasoning: "Testurteil.",
  at,
});

const history = (...entries: HistorySlice[]): { history: HistorySlice[] } => ({
  history: entries,
});

describe("judgmentsForCurrentWording", () => {
  const older = judgment("codex", "partially_supports", "2026-08-24T10:00:00Z");
  const newer = judgment("claude", "supports", "2026-08-25T14:00:00Z");

  it("keeps every judgment for a claim that was never revised", () => {
    const claim = history({
      to_status: "pending_adjudication",
      at: "2026-08-25T12:00:00Z",
    });
    expect(judgmentsForCurrentWording(claim, [older, newer])).toEqual([
      older,
      newer,
    ]);
  });

  it("drops judgments that predate the last wording revision", () => {
    const claim = history(
      { to_status: "revised", at: "2026-08-25T13:00:00Z" },
      { to_status: "existence_checked", at: "2026-08-25T13:00:01Z" },
    );
    expect(judgmentsForCurrentWording(claim, [older, newer])).toEqual([newer]);
  });

  it("cuts at the LAST revision when there were several", () => {
    const between = judgment("codex", "supports", "2026-08-25T12:30:00Z");
    const claim = history(
      { to_status: "revised", at: "2026-08-25T12:00:00Z" },
      { to_status: "revised", at: "2026-08-25T13:00:00Z" },
    );
    expect(judgmentsForCurrentWording(claim, [older, between, newer])).toEqual([
      newer,
    ]);
  });

  it("prevents the phantom divergence a stale secondary judgment caused", () => {
    // Observed live (clm_0012): claude re-judged the REVISED wording with a
    // confident "supports", so the second opinion never armed — and codex's
    // judgment of the OLD wording read as divergence.
    const claim = history({
      to_status: "revised",
      at: "2026-08-25T13:00:00Z",
    });
    expect(resolveEvidenceRelation([older, newer])).toBeNull();
    expect(
      resolveEvidenceRelation(
        judgmentsForCurrentWording(claim, [older, newer]),
      ),
    ).toBe("supports");
  });
});
