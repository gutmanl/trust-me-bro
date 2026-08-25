import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../../register";
import { buildEvidenceDisplayMap } from "./evidence-display";

const SHA = "a".repeat(64);

function registerWith(overrides: {
  blobExt?: string;
  page?: number;
  judgments?: unknown[];
  relation?: string;
}): ClaimsRegister {
  const { blobExt, page, judgments = [], relation } = overrides;
  return {
    sources: [
      {
        id: "src_0001",
        type: "article-journal",
        title: "Quelle",
        custom: {
          source_type: "preprint",
          ...(blobExt
            ? {
                snapshot: {
                  retrieved_at: "2026-08-08T09:00:00Z",
                  sha256: SHA,
                  blob_path: `blobs/aa/${SHA}.${blobExt}`,
                  revision: 1,
                },
              }
            : {}),
        },
      },
    ],
    claims: [
      {
        history: [],
        id: "clm_0001",
        evidence: [
          {
            id: "ev_0001",
            source_id: "src_0001",
            locator: { ...(page ? { page } : {}), section: "3.1" },
            verbatim_excerpt: "Wörtlicher Auszug aus der Quelle.",
            ...(relation ? { relation_type: relation } : {}),
            judgments,
          },
        ],
      },
    ],
  } as unknown as ClaimsRegister;
}

describe("buildEvidenceDisplayMap", () => {
  it("links PDF snapshots to the page anchor", () => {
    const display = buildEvidenceDisplayMap(
      "proj_x",
      registerWith({ blobExt: "pdf", page: 7 }),
    )["clm_0001/ev_0001"];
    expect(display.snapshotHref).toBe(
      `/api/projects/proj_x/blobs/blobs/aa/${SHA}.pdf#page=7`,
    );
    expect(display.locatorText).toBe("S. 7, Abschn. 3.1");
    expect(display.sourceType).toBe("preprint");
  });

  it("links HTML snapshots via text fragment on the excerpt", () => {
    const display = buildEvidenceDisplayMap(
      "proj_x",
      registerWith({ blobExt: "html" }),
    )["clm_0001/ev_0001"];
    expect(display.snapshotHref).toContain("#:~:text=");
    expect(display.snapshotHref).toContain(
      encodeURIComponent("Wörtlicher Auszug"),
    );
  });

  it("has no snapshot link without a snapshot and falls back on citation", () => {
    const display = buildEvidenceDisplayMap("proj_x", registerWith({}))[
      "clm_0001/ev_0001"
    ];
    expect(display.snapshotHref).toBeNull();
    expect(display.citation.length).toBeGreaterThan(0);
  });

  it("flags divergence only for unresolved disagreeing judgments", () => {
    const judgments = [
      {
        backend: "claude",
        model: "m1",
        relation_type: "supports",
        confidence: 0.9,
        reasoning: "…",
        at: "2026-08-08T09:00:00Z",
      },
      {
        backend: "codex",
        model: "m2",
        relation_type: "contradicts",
        confidence: 0.8,
        reasoning: "…",
        at: "2026-08-08T09:01:00Z",
      },
    ];
    const divergent = buildEvidenceDisplayMap(
      "proj_x",
      registerWith({ judgments }),
    )["clm_0001/ev_0001"];
    expect(divergent.divergent).toBe(true);

    const resolved = buildEvidenceDisplayMap(
      "proj_x",
      registerWith({ judgments, relation: "supports" }),
    )["clm_0001/ev_0001"];
    expect(resolved.divergent).toBe(false);
  });
});
