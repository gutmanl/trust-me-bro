import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RecheckPreview, RecheckScope } from "@/lib/pipeline";
import {
  buildRungView,
  exclusionsLine,
  forcingTarget,
  RECHECK_RUNGS,
  RecheckSweepDialog,
  RecheckSweepItemisation,
  SWEEP_COPY,
  typedMatches,
} from "./RecheckSweepDialog";

/**
 * The sweep confirmation's markup and its arithmetic (RERUN-02, RERUN-04).
 *
 * Server-rendered with `renderToStaticMarkup`, the seam
 * `SourceRow.test.tsx` established: the dialog is a client component, but
 * `useActionState` and `useState` render on the server and `Modal` needs no
 * provider, so the initial state of every variant is reachable without
 * jsdom — and none may be added.
 *
 * WHAT THIS FILE CANNOT REACH, STATED SO NOBODY MISTAKES GREEN FOR DONE.
 * The forcing step's actual blocking — type a wrong number, watch the
 * submit stay disabled, type the right one, watch it enable — is three
 * interactions and lives in `tests/browser/review.spec.ts`. Here the
 * arithmetic behind it is pinned as pure functions and the initial disabled
 * submit as markup.
 *
 * Every German assertion compares against the exported constant rather than
 * a literal retyped here: a copy drift must fail against the Copywriting
 * Contract, and two independent transcriptions of the same German sentence
 * would only ever fail against each other.
 */

function rung(
  scope: RecheckScope,
  claimIds: string[],
  queued: number,
  confirmed: number,
  exclusions: Partial<{
    open_in_workbench: number;
    discarded: number;
    legacy_unrouted: number;
    human_confirmed: number;
    vintage_current: number;
  }> = {},
) {
  return {
    scope,
    claimIds,
    total: claimIds.length,
    queued,
    confirmed,
    exclusions: {
      open_in_workbench: 0,
      discarded: 0,
      legacy_unrouted: 0,
      human_confirmed: 0,
      vintage_current: 0,
      ...exclusions,
    },
  };
}

/**
 * A project mid-review: four stale claims of which two await adjudication,
 * six once the current-vintage ones are included, seven with the confirmed
 * one — the nesting the ladder promises. Two claims are excluded for named
 * reasons on every rung.
 */
const PREVIEW: RecheckPreview = {
  stale: rung("stale", ["clm_0001", "clm_0002", "clm_0003", "clm_0004"], 2, 0, {
    discarded: 1,
    legacy_unrouted: 1,
    human_confirmed: 1,
    vintage_current: 2,
  }),
  all: rung(
    "all",
    ["clm_0001", "clm_0002", "clm_0003", "clm_0004", "clm_0005", "clm_0006"],
    2,
    0,
    { discarded: 1, legacy_unrouted: 1, human_confirmed: 1 },
  ),
  all_including_confirmed: rung(
    "all_including_confirmed",
    [
      "clm_0001",
      "clm_0002",
      "clm_0003",
      "clm_0004",
      "clm_0005",
      "clm_0006",
      "clm_0007",
    ],
    2,
    1,
    { discarded: 1, legacy_unrouted: 1 },
  ),
};

/** Nothing stale left — the empty-state rung — but the wider rungs still
 * select. This is the state the empty-state copy is written for. */
const EMPTY_STALE_PREVIEW: RecheckPreview = {
  stale: rung("stale", [], 0, 0, { vintage_current: 3 }),
  all: rung("all", ["clm_0001", "clm_0002", "clm_0003"], 1, 0),
  all_including_confirmed: rung(
    "all_including_confirmed",
    ["clm_0001", "clm_0002", "clm_0003"],
    1,
    0,
  ),
};

/** Nothing queued anywhere, and nothing excluded — the degenerate case for
 * the forcing step and the absence case for the exclusions line. */
const NO_QUEUE_PREVIEW: RecheckPreview = {
  stale: rung("stale", ["clm_0001", "clm_0002", "clm_0003"], 0, 0),
  all: rung("all", ["clm_0001", "clm_0002", "clm_0003"], 0, 0),
  all_including_confirmed: rung(
    "all_including_confirmed",
    ["clm_0001", "clm_0002", "clm_0003"],
    0,
    0,
  ),
};

function renderDialog(
  preview: RecheckPreview,
  selectedClaimId: string | null = null,
  selectedClaimIsQueued = false,
): string {
  return renderToStaticMarkup(
    <RecheckSweepDialog
      projectId="proj_x"
      preview={preview}
      selectedClaimId={selectedClaimId}
      selectedClaimIsQueued={selectedClaimIsQueued}
      onClose={() => {}}
      onRequested={() => {}}
    />,
  );
}

function renderItemisation(
  preview: RecheckPreview,
  scope: RecheckScope,
  selectedClaimId: string | null = null,
  selectedClaimIsQueued = false,
): string {
  return renderToStaticMarkup(
    <RecheckSweepItemisation
      view={buildRungView(
        preview,
        scope,
        selectedClaimId,
        selectedClaimIsQueued,
      )}
      scope={scope}
    />,
  );
}

describe("the scope ladder", () => {
  it("renders all three rungs with their German labels, hints and counts", () => {
    const markup = renderDialog(PREVIEW);

    for (const entry of RECHECK_RUNGS) {
      expect(markup).toContain(entry.hint);
    }
    // Label plus that rung's own count, so the reviewer can compare the
    // rungs before choosing one rather than after.
    expect(markup).toContain("Nur veraltete Vorprüfungen (4)");
    expect(markup).toContain("Alle vorgeprüften Aussagen (6)");
    expect(markup).toContain("Auch bestätigte Aussagen (7)");
    expect(markup).toContain(SWEEP_COPY.ladderLegend);
  });

  it("carries the English enum values under the German labels", () => {
    const markup = renderDialog(PREVIEW);

    expect(RECHECK_RUNGS.map((entry) => entry.value)).toEqual([
      "stale",
      "all",
      "all_including_confirmed",
    ]);
    expect(markup).toContain('value="stale"');
    expect(markup).toContain('value="all"');
    expect(markup).toContain('value="all_including_confirmed"');
    // One radio group named for the field the server action reads.
    expect(markup.match(/name="scope"/g)).toHaveLength(3);
  });

  it("defaults to the narrowest rung", () => {
    const markup = renderDialog(PREVIEW);

    expect(markup).toContain(SWEEP_COPY.total(4));
    expect(markup).not.toContain(SWEEP_COPY.total(7));
  });
});

describe("the itemisation", () => {
  it("names the total and the queued sub-count, never a bare total", () => {
    const markup = renderItemisation(PREVIEW, "stale");

    expect(markup).toContain(SWEEP_COPY.itemisationHeading);
    expect(markup).toContain(SWEEP_COPY.total(4));
    expect(markup).toContain(SWEEP_COPY.queued(2));
  });

  it("shows the confirmed row only on the rung that un-confirms", () => {
    expect(renderItemisation(PREVIEW, "stale")).not.toContain(
      SWEEP_COPY.confirmed(1),
    );
    expect(renderItemisation(PREVIEW, "all")).not.toContain(
      SWEEP_COPY.confirmed(1),
    );
    expect(renderItemisation(PREVIEW, "all_including_confirmed")).toContain(
      SWEEP_COPY.confirmed(1),
    );
  });

  it("pluralises the total as a full German sentence", () => {
    expect(SWEEP_COPY.total(1)).toBe("1 Aussage wird erneut geprüft");
    expect(SWEEP_COPY.total(4)).toBe("4 Aussagen werden erneut geprüft");
    // The „Aussage(n)" shorthand of the older chips is banned in new copy.
    expect(renderDialog(PREVIEW)).not.toContain("Aussage(n)");
  });

  it("names each exclusion group only when its count is non-zero", () => {
    const markup = renderItemisation(PREVIEW, "stale");

    expect(markup).toContain(SWEEP_COPY.exclusionDiscarded(1));
    expect(markup).toContain(SWEEP_COPY.exclusionLegacy(1));
    // Nobody has a claim open in this render, so that group is absent from
    // the line rather than rendered as „0 gerade geöffnet".
    expect(markup).not.toContain("gerade geöffnet");
  });

  it("omits the whole exclusions line when nothing is excluded", () => {
    const markup = renderItemisation(NO_QUEUE_PREVIEW, "stale");

    expect(markup).not.toContain(SWEEP_COPY.exclusionsPrefix);
    expect(
      exclusionsLine(buildRungView(NO_QUEUE_PREVIEW, "stale", null, false)),
    ).toBeNull();
  });
});

describe("the claim the reviewer has open (RERUN-04)", () => {
  it("is subtracted from the rung's count and named in the exclusions line", () => {
    const view = buildRungView(PREVIEW, "stale", "clm_0002", true);

    expect(view.total).toBe(3);
    // It was one of the two queued claims, so the queued sub-count drops
    // with it — otherwise the forcing step would ask for a number the
    // sweep will not act on.
    expect(view.queued).toBe(1);
    expect(view.excludedOpen).toBe(1);

    const markup = renderItemisation(PREVIEW, "stale", "clm_0002", true);
    expect(markup).toContain(SWEEP_COPY.total(3));
    expect(markup).toContain(SWEEP_COPY.exclusionOpen(1));
  });

  it("is reported as open on every rung, including one that never selected it", () => {
    // clm_0007 is the confirmed claim: only the top rung selects it. The
    // server classifies `open_in_workbench` BEFORE the rung filters, so the
    // narrow rungs must report it under the same group rather than let it
    // vanish into a rung-definitional count.
    const stale = buildRungView(PREVIEW, "stale", "clm_0007", false);
    expect(stale.total).toBe(4);
    expect(stale.excludedOpen).toBe(1);

    const top = buildRungView(
      PREVIEW,
      "all_including_confirmed",
      "clm_0007",
      false,
    );
    expect(top.total).toBe(6);
    expect(top.confirmed).toBe(0);
    expect(top.excludedOpen).toBe(1);
  });

  it("leaves the counts alone when the open claim was never a candidate", () => {
    const view = buildRungView(PREVIEW, "stale", "clm_9999", false);

    expect(view.total).toBe(4);
    expect(view.excludedOpen).toBe(0);
  });
});

describe("the forcing step", () => {
  it("asks for the queued count and starts with the submit disabled", () => {
    const markup = renderDialog(PREVIEW);

    expect(markup).toContain(SWEEP_COPY.forcingLabelQueued);
    expect(markup).not.toContain(SWEEP_COPY.forcingLabelTotal);
    expect(markup).toContain('name="queued_confirmation"');
    expect(markup).toContain('inputMode="numeric"');
    expect(markup).toContain("disabled");
    expect(forcingTarget(buildRungView(PREVIEW, "stale", null, false))).toBe(2);
  });

  it("asks for the total instead when nothing is queued", () => {
    const markup = renderDialog(NO_QUEUE_PREVIEW);

    expect(markup).toContain(SWEEP_COPY.forcingLabelTotal);
    expect(markup).not.toContain(SWEEP_COPY.forcingLabelQueued);
    expect(
      forcingTarget(buildRungView(NO_QUEUE_PREVIEW, "stale", null, false)),
    ).toBe(3);
  });

  it("compares as a base-ten integer after trimming, never as a raw string", () => {
    expect(typedMatches("2", 2)).toBe(true);
    expect(typedMatches("  2 ", 2)).toBe(true);
    // A leading zero demonstrates the reviewer read the number just as well
    // as the bare digit does; a raw string compare would reject it.
    expect(typedMatches("02", 2)).toBe(true);
    expect(typedMatches("3", 2)).toBe(false);
    expect(typedMatches("", 2)).toBe(false);
    expect(typedMatches("zwei", 2)).toBe(false);
    expect(typedMatches("2x", 2)).toBe(false);
    expect(typedMatches("-2", 2)).toBe(false);
  });

  it("does not show the mismatch hint before anything is typed", () => {
    expect(renderDialog(PREVIEW)).not.toContain(SWEEP_COPY.forcingMismatch);
  });
});

describe("a rung that selects nothing", () => {
  it("replaces the itemisation with the empty state and drops the submit", () => {
    const markup = renderDialog(EMPTY_STALE_PREVIEW);

    expect(markup).toContain(SWEEP_COPY.emptyHeading);
    expect(markup).toContain(SWEEP_COPY.emptyBody);
    expect(markup).not.toContain(SWEEP_COPY.itemisationHeading);
    expect(markup).not.toContain(SWEEP_COPY.cta(0));
    // No forcing field either — typing „0" is friction without cognition.
    expect(markup).not.toContain('name="queued_confirmation"');
    // Cancel stays, and so does the ladder, so the reviewer can escalate a
    // rung instead of reopening the dialog.
    expect(markup).toContain(SWEEP_COPY.cancel);
    expect(markup).toContain("Alle vorgeprüften Aussagen (3)");
  });
});

describe("the banned copy guard", () => {
  const markups = [
    renderDialog(PREVIEW),
    renderDialog(PREVIEW, "clm_0002", true),
    renderDialog(EMPTY_STALE_PREVIEW),
    renderDialog(NO_QUEUE_PREVIEW),
  ];

  it("never frames the sweep as updating or improving the reasoning", () => {
    for (const markup of markups) {
      expect(markup).not.toMatch(/aktualisiert|verbessert|genauer/);
    }
  });

  it("never says anything is lost, deleted or irreversible", () => {
    for (const markup of markups) {
      expect(markup).not.toMatch(/geht verloren|gelöscht|unwiderruflich/);
    }
  });

  it("never shows a cost figure or a percentage", () => {
    for (const markup of markups) {
      expect(markup).not.toContain("€");
      expect(markup).not.toContain("%");
      expect(markup).not.toMatch(/EUR|Kosten|Euro/);
    }
  });

  it("never uses red or destructive styling", () => {
    // After the archive nothing is destroyed; red would assert the very
    // thing this phase removed. The friction is the itemisation and the
    // typed number, not the colour.
    for (const markup of markups) {
      expect(markup).not.toContain("text-red-");
      expect(markup).not.toContain("bg-red-");
      expect(markup).not.toContain("border-red-");
    }
  });

  it("never renders a claim id", () => {
    // A forty-item list would push the forcing field below the fold and
    // make the last thing the reviewer sees a wall of ids. The one id the
    // dialog knows travels in a hidden field, not in prose — so the guard
    // is over the VISIBLE text.
    const visible = renderDialog(PREVIEW, "clm_0002", true).replace(
      /<input[^>]*>/g,
      "",
    );
    for (const id of PREVIEW.all_including_confirmed.claimIds) {
      expect(visible).not.toContain(id);
    }
  });

  it("never reassures the reviewer about the result", () => {
    for (const markup of markups) {
      expect(markup).not.toMatch(/zuverlässig|eindeutig|endgültig|keine Sorge/);
    }
  });
});
