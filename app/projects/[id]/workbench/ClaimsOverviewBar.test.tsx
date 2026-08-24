import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProjectEventStreamContext } from "@/app/lib/ProjectEventStream";
import type {
  ProjectActivity,
  ProjectMetrics,
  RecheckPreview,
  VerificationState,
} from "@/lib/pipeline";
import type { ClaimStatus } from "@/lib/register";
import { BAR_RECHECK_COPY, ClaimsOverviewBar } from "./ClaimsOverviewBar";
import { SWEEP_COPY } from "./RecheckSweepDialog";

/**
 * The bar's re-verification surfaces (RERUN-02 placement, RERUN-07,
 * D-16's one-time summary).
 *
 * Server-rendered through `renderToStaticMarkup` with the event-stream
 * context supplied explicitly — the context is exported for exactly this,
 * so the run-BLOCKED half of a run-gated control is assertable here instead
 * of only in Playwright.
 */

const EMPTY_COUNTS = {
  captured: 0,
  existence_checked: 0,
  prechecked: 0,
  pending_adjudication: 0,
  auto_confirmed: 0,
  confirmed: 0,
  contested: 0,
  recheck_required: 0,
  repair_suggested: 0,
  repair_applied: 0,
  revised: 0,
  discarded: 0,
} as unknown as Record<ClaimStatus, number>;

const PREVIEW: RecheckPreview = {
  stale: {
    scope: "stale",
    claimIds: ["clm_0001", "clm_0002"],
    total: 2,
    queued: 1,
    confirmed: 0,
    exclusions: {
      open_in_workbench: 0,
      discarded: 0,
      legacy_unrouted: 0,
      not_returnable: 0,
      human_confirmed: 0,
      vintage_current: 0,
    },
  },
  all: {
    scope: "all",
    claimIds: ["clm_0001", "clm_0002"],
    total: 2,
    queued: 1,
    confirmed: 0,
    exclusions: {
      open_in_workbench: 0,
      discarded: 0,
      legacy_unrouted: 0,
      not_returnable: 0,
      human_confirmed: 0,
      vintage_current: 0,
    },
  },
  all_including_confirmed: {
    scope: "all_including_confirmed",
    claimIds: ["clm_0001", "clm_0002"],
    total: 2,
    queued: 1,
    confirmed: 0,
    exclusions: {
      open_in_workbench: 0,
      discarded: 0,
      legacy_unrouted: 0,
      not_returnable: 0,
      human_confirmed: 0,
      vintage_current: 0,
    },
  },
};

const NO_RECHECK: ProjectMetrics["reverification"] = {
  reverified_claims: 0,
  changed_result_claims: 0,
};

const RUNNING_TRIGGER: ProjectActivity = {
  source: "trigger",
  triggerId: "trg_1",
  kind: "anchor_repair",
  description: "Ankerprüfung",
  startedAt: "2026-08-24T08:00:00Z",
  phase: "running",
};

function renderBar(options: {
  verificationState?: Partial<VerificationState>;
  reverification?: ProjectMetrics["reverification"];
  activity?: ProjectActivity | null;
  totalClaims?: number;
  recheckPreview?: RecheckPreview | null;
}): string {
  const verificationState: VerificationState = {
    status: "not_started",
    openClaims: 2,
    totalClaims: 2,
    precededByRecheck: false,
    ...options.verificationState,
  };
  return renderToStaticMarkup(
    <ProjectEventStreamContext.Provider
      value={{
        activity: options.activity ?? null,
        activeRun: null,
        connectionLost: false,
        subscribe: () => () => {},
      }}
    >
      <ClaimsOverviewBar
        projectId="proj_x"
        counts={EMPTY_COUNTS}
        totalClaims={options.totalClaims ?? 2}
        decided={0}
        everQueued={0}
        openCount={0}
        openExistenceCount={0}
        existenceCheckRunning={false}
        verificationRunning={false}
        verificationState={verificationState}
        verificationBlockedReason={null}
        runBarVisible={false}
        onJumpToNextOpen={() => {}}
        selectedClaimId={null}
        selectedClaimIsQueued={false}
        recheckPreview={
          options.recheckPreview === undefined
            ? PREVIEW
            : options.recheckPreview
        }
        reverification={options.reverification ?? NO_RECHECK}
      />
    </ProjectEventStreamContext.Provider>,
  );
}

/**
 * The sweep trigger's own `<button …>` opening tag.
 *
 * Extracted rather than matched with a `[^>]*disabled[^>]*` regex over the
 * whole tag: `compactSecondaryButtonClass` contains the Tailwind variant
 * `disabled:opacity-50`, so that pattern matches the CLASS list and reports
 * every render as disabled — a test that can only pass. The attribute React
 * emits is ` disabled=""`, which the class list cannot produce.
 */
function sweepButtonTag(markup: string): string {
  const label = markup.indexOf(SWEEP_COPY.trigger);
  expect(label).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<button", label);
  return markup.slice(open, label);
}

function isSweepDisabled(markup: string): boolean {
  return / disabled=""/.test(sweepButtonTag(markup));
}

describe("the sweep trigger's placement", () => {
  it("sits after the start-verification form, never before it", () => {
    // The primary in this bar stays the button that STARTS a run; the sweep
    // only marks claims for it. Order is half of what makes the sweep read
    // as behind the per-claim default.
    const markup = renderBar({});
    const start = markup.indexOf("KI-Prüfung starten");
    const sweep = markup.indexOf(SWEEP_COPY.trigger);

    expect(start).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(start);
  });

  it("is absent from a project with no claims", () => {
    expect(renderBar({ totalClaims: 0 })).not.toContain(SWEEP_COPY.trigger);
  });

  it("is absent when the preview could not be computed", () => {
    // The itemisation IS the mitigation, so a dialog that cannot itemise is
    // worth less than no dialog. What must never happen is the whole
    // workbench page failing because one optional affordance could not
    // resolve the project's rubric pin — see `loadRecheckPreview`.
    expect(renderBar({ recheckPreview: null })).not.toContain(
      SWEEP_COPY.trigger,
    );
    // And the rest of the bar still renders.
    expect(renderBar({ recheckPreview: null })).toContain("KI-Prüfung starten");
  });

  it("is not the filled primary button", () => {
    const markup = renderBar({});
    // The quiet outline register — a white background and a slate border,
    // not the filled slate-900 of the start button beside it.
    expect(sweepButtonTag(markup)).toContain("border-slate-300");
    expect(sweepButtonTag(markup)).not.toContain("bg-slate-900");
  });
});

describe("a live activity (RERUN-07)", () => {
  it("disables the trigger and says what is blocking it", () => {
    const markup = renderBar({ activity: RUNNING_TRIGGER });

    expect(isSweepDisabled(markup)).toBe(true);
    // Visible text, never a `title` alone: a disabled control with no
    // explanation is the silent failure RERUN-07 names.
    expect(markup).toContain("Ankerprüfung läuft gerade – bitte abwarten.");
  });

  it("leaves the trigger pressable when nothing is running", () => {
    const markup = renderBar({});

    expect(isSweepDisabled(markup)).toBe(false);
    expect(markup).not.toContain("läuft gerade – bitte abwarten.");
  });
});

describe("the one-time post-run summary (D-16)", () => {
  const completedAfterRecheck: Partial<VerificationState> = {
    status: "completed",
    openClaims: 0,
    completedAt: "2026-08-24T09:00:00Z",
    precededByRecheck: true,
  };

  it("reports the two counts and the non-reproducibility sentence", () => {
    const markup = renderBar({
      verificationState: completedAfterRecheck,
      reverification: { reverified_claims: 7, changed_result_claims: 2 },
    });

    expect(markup).toContain(BAR_RECHECK_COPY.postRun1(2, 7));
    expect(markup).toContain(BAR_RECHECK_COPY.postRun2);
  });

  it("never publishes a rate", () => {
    const markup = renderBar({
      verificationState: completedAfterRecheck,
      reverification: { reverified_claims: 7, changed_result_claims: 2 },
    });

    // Two absolute counts and no denominator-as-headline: a percentage here
    // would be read as an agreement or accuracy rate.
    expect(markup).not.toContain("%");
    expect(markup).not.toMatch(/Trefferquote|Genauigkeit|Zuverlässigkeit/);
  });

  it("is absent when no re-run bracket preceded the run", () => {
    const markup = renderBar({
      verificationState: {
        status: "completed",
        openClaims: 0,
        completedAt: "2026-08-24T09:00:00Z",
        precededByRecheck: false,
      },
      reverification: { reverified_claims: 7, changed_result_claims: 2 },
    });

    expect(markup).not.toContain("Erneute Prüfung abgeschlossen");
  });

  it("is absent while the re-run has not completed yet", () => {
    const markup = renderBar({
      verificationState: {
        status: "interrupted",
        openClaims: 1,
        precededByRecheck: true,
      },
      reverification: { reverified_claims: 7, changed_result_claims: 2 },
    });

    expect(markup).not.toContain("Erneute Prüfung abgeschlossen");
  });

  it("is never a zero state", () => {
    const markup = renderBar({
      verificationState: completedAfterRecheck,
      reverification: NO_RECHECK,
    });

    expect(markup).not.toContain("Erneute Prüfung abgeschlossen");
  });

  it("pluralises both counts as full German sentences", () => {
    expect(BAR_RECHECK_COPY.postRun1(1, 1)).toBe(
      "Erneute Prüfung abgeschlossen: 1 von 1 erneut geprüften Aussage " +
        "kommt zu einem anderen Ergebnis als zuvor.",
    );
    expect(BAR_RECHECK_COPY.postRun1(2, 7)).toBe(
      "Erneute Prüfung abgeschlossen: 2 von 7 erneut geprüften Aussagen " +
        "kommen zu einem anderen Ergebnis als zuvor.",
    );
  });
});

describe("the sweep's success line", () => {
  it("names the marked claims and points at the button that runs them", () => {
    expect(BAR_RECHECK_COPY.sweepSuccess(4)).toBe(
      "4 Aussagen zur Nachprüfung vorgemerkt – mit „KI-Prüfung starten“ " +
        "beginnt der Lauf.",
    );
    expect(BAR_RECHECK_COPY.sweepSuccess(1)).toBe(
      "1 Aussage zur Nachprüfung vorgemerkt – mit „KI-Prüfung starten“ " +
        "beginnt der Lauf.",
    );
  });

  it("accounts for the claims that were not marked", () => {
    expect(BAR_RECHECK_COPY.sweepExcluded(1)).toBe(
      "1 Aussage wurde nicht vorgemerkt.",
    );
    expect(BAR_RECHECK_COPY.sweepExcluded(3)).toBe(
      "3 Aussagen wurden nicht vorgemerkt.",
    );
  });
});
