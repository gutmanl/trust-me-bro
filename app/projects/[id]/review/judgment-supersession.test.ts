import { describe, expect, it } from "vitest";

import type { Judgment, RelationType } from "@/lib/register";
import { deriveSupersededJudgments } from "./judgment-supersession";

function judgment(
  backend: string,
  relation: RelationType,
  at: string,
): Judgment {
  return {
    backend,
    model: "mock-1",
    relation_type: relation,
    confidence: 0.8,
    reasoning: "Der Auszug deckt die Aussage.",
    at,
  };
}

describe("deriveSupersededJudgments", () => {
  it("reports nothing for a single judgment", () => {
    expect(
      deriveSupersededJudgments([
        judgment("claude", "supports", "2026-08-14T09:12:00Z"),
      ]),
    ).toEqual([]);
  });

  it("reports nothing when a backend repeated itself", () => {
    // A re-run that reached the same conclusion superseded nothing the
    // reviewer needs to know about.
    expect(
      deriveSupersededJudgments([
        judgment("claude", "supports", "2026-08-14T09:12:00Z"),
        judgment("claude", "supports", "2026-08-19T11:00:00Z"),
      ]),
    ).toEqual([]);
  });

  it("reports a backend that changed its own mind", () => {
    expect(
      deriveSupersededJudgments([
        judgment("claude", "partially_supports", "2026-08-14T09:12:00Z"),
        judgment("claude", "contradicts", "2026-08-19T11:00:00Z"),
      ]),
    ).toEqual([
      {
        backend: "claude",
        previousRelation: "partially_supports",
        previousAt: "2026-08-14T09:12:00Z",
        currentRelation: "contradicts",
        currentAt: "2026-08-19T11:00:00Z",
      },
    ]);
  });

  it("reports nothing when two backends merely disagree with each other", () => {
    // That is divergence, already reported by EvidenceDisplay.divergent.
    // Reporting it here too would double-report one fact and mislabel it as
    // a self-revision.
    expect(
      deriveSupersededJudgments([
        judgment("claude", "supports", "2026-08-14T09:12:00Z"),
        judgment("codex", "contradicts", "2026-08-14T09:40:00Z"),
      ]),
    ).toEqual([]);
  });

  it("compares against the immediately previous judgment, not the first", () => {
    const superseded = deriveSupersededJudgments([
      judgment("claude", "supports", "2026-08-12T09:00:00Z"),
      judgment("claude", "contradicts", "2026-08-14T09:00:00Z"),
      judgment("claude", "supports", "2026-08-19T09:00:00Z"),
    ]);
    expect(superseded).toHaveLength(1);
    expect(superseded[0].previousRelation).toBe("contradicts");
    expect(superseded[0].currentRelation).toBe("supports");
  });

  it("reports each backend independently", () => {
    const superseded = deriveSupersededJudgments([
      judgment("claude", "supports", "2026-08-12T09:00:00Z"),
      judgment("codex", "supports", "2026-08-12T09:30:00Z"),
      judgment("claude", "contradicts", "2026-08-19T09:00:00Z"),
      judgment("codex", "supports", "2026-08-19T09:30:00Z"),
    ]);
    expect(superseded).toHaveLength(1);
    expect(superseded[0].backend).toBe("claude");
  });

  it("distinguishes a three-judgment claim from a one-judgment claim", () => {
    // ROADMAP success criterion 5, stated as its own case.
    const one = deriveSupersededJudgments([
      judgment("claude", "supports", "2026-08-12T09:00:00Z"),
    ]);
    const three = deriveSupersededJudgments([
      judgment("claude", "supports", "2026-08-12T09:00:00Z"),
      judgment("codex", "supports", "2026-08-12T09:30:00Z"),
      judgment("claude", "contradicts", "2026-08-19T09:00:00Z"),
    ]);
    expect(one).toEqual([]);
    expect(three).not.toEqual([]);
  });
});
