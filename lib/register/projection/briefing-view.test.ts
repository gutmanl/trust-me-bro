import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../schema/register";
import { buildBriefingViewModel } from "./briefing-view";
import { renderBriefing } from "./render-briefing";

/** Minimal register stub — the projection reads fields, it never validates. */
function registerWith(
  claims: {
    id: string;
    status: string;
    anchor: string;
    anchorQuote?: string;
    evidenceIds?: string[];
  }[],
): ClaimsRegister {
  return {
    project: { id: "proj_x", research_question: "Frage?" },
    claims: claims.map((entry) => ({
      id: entry.id,
      text: `Text von ${entry.id}`,
      status: entry.status,
      briefing_anchor: entry.anchor,
      ...(entry.anchorQuote !== undefined
        ? { anchor_quote: entry.anchorQuote }
        : {}),
      evidence: (entry.evidenceIds ?? []).map((evidenceId) => ({
        id: evidenceId,
        source_id: "src_0001",
        locator: { page: 1 },
        verbatim_excerpt: "Auszug",
        judgments: [],
      })),
      history: [],
    })),
    project_events: [],
    sources: [],
  } as unknown as ClaimsRegister;
}

const BRIEFING = "Absatz eins.\n\nAbsatz zwei.";

describe("buildBriefingViewModel", () => {
  it("anchors claims to paragraphs and buckets unresolvable anchors", () => {
    const view = buildBriefingViewModel(
      BRIEFING,
      registerWith([
        { id: "clm_0002", status: "captured", anchor: "p2" },
        { id: "clm_0001", status: "captured", anchor: "p1" },
        { id: "clm_0003", status: "captured", anchor: "p9" },
        { id: "clm_0004", status: "captured", anchor: "kaputt" },
      ]),
    );
    expect(view.paragraphs).toHaveLength(2);
    expect(view.paragraphs[0].claims.map((m) => m.claim.id)).toEqual([
      "clm_0001",
    ]);
    expect(view.paragraphs[1].claims.map((m) => m.claim.id)).toEqual([
      "clm_0002",
    ]);
    expect(view.unanchored.map((m) => m.claim.id)).toEqual([
      "clm_0003",
      "clm_0004",
    ]);
  });

  it("numbers evidence globally in deterministic claim order", () => {
    const view = buildBriefingViewModel(
      BRIEFING,
      registerWith([
        {
          id: "clm_0002",
          status: "captured",
          anchor: "p1",
          evidenceIds: ["ev_b"],
        },
        {
          id: "clm_0001",
          status: "captured",
          anchor: "p1",
          evidenceIds: ["ev_a1", "ev_a2"],
        },
      ]),
    );
    // Order: clm_0001 (id tiebreak) before clm_0002.
    expect(view.evidenceNumbers).toEqual({
      "clm_0001/ev_a1": 1,
      "clm_0001/ev_a2": 2,
      "clm_0002/ev_b": 3,
    });
    expect(view.orderedClaims.map((m) => m.claim.id)).toEqual([
      "clm_0001",
      "clm_0002",
    ]);
  });

  it("derives the fully-adjudicated banner exactly from open adjudication claims", () => {
    const open = buildBriefingViewModel(
      BRIEFING,
      registerWith([
        { id: "clm_0001", status: "pending_adjudication", anchor: "p1" },
      ]),
    );
    expect(open.isFullyAdjudicated).toBe(false);
    expect(open.openCount).toBe(1);

    const done = buildBriefingViewModel(
      BRIEFING,
      registerWith([
        { id: "clm_0001", status: "confirmed", anchor: "p1" },
        { id: "clm_0002", status: "discarded", anchor: "p1" },
      ]),
    );
    expect(done.isFullyAdjudicated).toBe(true);
    expect(done.unconfirmedCount).toBe(1);
  });

  it("calls a claim-free briefing unstarted, never fully adjudicated", () => {
    // The state every briefing is in between its import and its first
    // extraction pass. "No claim is pending" is vacuously true here, and
    // reporting it as the checked-and-nothing-open banner told the user the
    // opposite of the truth: nothing had been looked at at all.
    const fresh = buildBriefingViewModel(BRIEFING, registerWith([]));
    expect(fresh.isFullyAdjudicated).toBe(false);
    expect(fresh.openCount).toBe(0);
    expect(renderBriefing(BRIEFING, registerWith([]))).toContain(
      "NICHT BEGONNEN – noch keine Claims aus dem Briefing extrahiert",
    );
  });

  it("agrees with the markdown projection on the banner line", () => {
    const register = registerWith([
      { id: "clm_0001", status: "pending_adjudication", anchor: "p1" },
    ]);
    const markdown = renderBriefing(BRIEFING, register);
    expect(markdown).toContain(
      "IN PRÜFUNG – 1 Claim(s) zur Adjudikation offen",
    );
  });

  it("resolves legacy claims (no anchor_quote) exactly as before, anchorDrifted false", () => {
    const view = buildBriefingViewModel(
      BRIEFING,
      registerWith([
        { id: "clm_0001", status: "captured", anchor: "p1" },
        { id: "clm_0002", status: "captured", anchor: "kaputt" },
      ]),
    );
    expect(view.paragraphs[0].claims.map((m) => m.claim.id)).toEqual([
      "clm_0001",
    ]);
    expect(view.paragraphs[0].claims[0].anchorDrifted).toBe(false);
    expect(view.unanchored.map((m) => m.claim.id)).toEqual(["clm_0002"]);
    expect(view.unanchored[0].anchorDrifted).toBe(false);
  });

  describe("quote-first anchor resolution", () => {
    const THREE_PARAGRAPHS = "Absatz eins.\n\nAbsatz zwei.\n\nAbsatz drei.";

    it("resolves at the hint when the quote is still there", () => {
      const view = buildBriefingViewModel(
        THREE_PARAGRAPHS,
        registerWith([
          {
            id: "clm_0001",
            status: "captured",
            anchor: "p1",
            anchorQuote: "Absatz eins",
          },
        ]),
      );
      expect(view.paragraphs[0].claims.map((m) => m.claim.id)).toEqual([
        "clm_0001",
      ]);
      expect(view.paragraphs[0].claims[0].anchorDrifted).toBe(false);
    });

    it("follows the quote to its new paragraph when the hint has moved", () => {
      const view = buildBriefingViewModel(
        THREE_PARAGRAPHS,
        registerWith([
          {
            id: "clm_0001",
            status: "captured",
            anchor: "p1",
            anchorQuote: "Absatz zwei",
          },
        ]),
      );
      expect(view.paragraphs[0].claims).toHaveLength(0);
      expect(view.paragraphs[1].claims.map((m) => m.claim.id)).toEqual([
        "clm_0001",
      ]);
      expect(view.paragraphs[1].claims[0].anchorDrifted).toBe(false);
    });

    it("falls back to the (still valid) hint with anchorDrifted when the quote is gone", () => {
      const view = buildBriefingViewModel(
        THREE_PARAGRAPHS,
        registerWith([
          {
            id: "clm_0001",
            status: "captured",
            anchor: "p1",
            anchorQuote: "nicht vorhandener Text",
          },
        ]),
      );
      expect(view.paragraphs[0].claims.map((m) => m.claim.id)).toEqual([
        "clm_0001",
      ]);
      expect(view.paragraphs[0].claims[0].anchorDrifted).toBe(true);
    });

    it("lands in unanchored with anchorDrifted when both the quote and the hint are gone", () => {
      const view = buildBriefingViewModel(
        THREE_PARAGRAPHS,
        registerWith([
          {
            id: "clm_0001",
            status: "captured",
            anchor: "p9",
            anchorQuote: "nicht vorhandener Text",
          },
        ]),
      );
      expect(view.unanchored.map((m) => m.claim.id)).toEqual(["clm_0001"]);
      expect(view.unanchored[0].anchorDrifted).toBe(true);
    });
  });
});
