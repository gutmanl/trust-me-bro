import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProjectEventStreamContext } from "@/app/lib/ProjectEventStream";
import type { ClaimMarkerVM } from "@/lib/pipeline";
import type { Claim, ClaimStatus } from "@/lib/register";
import { ClaimCard, RECHECK_COPY } from "./ClaimCard";

/**
 * The JSX half of surface 1, the per-claim re-run trigger.
 *
 * `renderToStaticMarkup` and nothing else — `SourceRow.test.tsx` is the
 * precedent, and `## Out of Scope` in REQUIREMENTS.md bars a DOM test
 * environment because it would need a new npm dependency. `ClaimCard` is a
 * client component, but `useActionState` and `useState` render on the
 * server, so the idle rendering needs no provider; the BLOCKED rendering
 * does, which is why `ProjectEventStreamContext` is exported.
 *
 * What this pins that nothing else does: that the trigger is present at all
 * on an eligible card, that it is ABSENT rather than disabled on an
 * ineligible one, that a live activity disables it with a visible reason,
 * and that the copy matches the contract word for word.
 */

/**
 * The Copywriting Contract's Surface 1 table, transcribed INDEPENDENTLY of
 * the component's own constant and compared against it below.
 *
 * Asserting the rendered markup against `RECHECK_COPY` alone would follow a
 * copy edit rather than catch it — the test would simply drift with the
 * component. Two transcriptions of one approved table is the only form in
 * which "the copy still matches the contract" is actually checkable here.
 */
const CONTRACT = {
  trigger: "Prüfung erneut ausführen",
  confirmHeading: "Diese Aussage erneut prüfen?",
  confirmBody1:
    "Die Prüfung beginnt wieder bei der Zitatprüfung (Stufe 1) und durchläuft danach die KI-Prüfstufen erneut.",
  confirmBody2:
    "Die bisherige Bewertung und ihre Begründung werden überschrieben und archiviert – sie bleiben auf dieser Karte lesbar.",
  confirmBodyConfirmed:
    "Die Bestätigung entfällt dabei und muss danach erneut erfolgen.",
  confirmBody4: "Das Ergebnis kann von der bisherigen Bewertung abweichen.",
  cta: "Erneut prüfen",
  ctaPending: "Wird vorgemerkt …",
  cancel: "Abbrechen",
  success:
    "Zur Nachprüfung vorgemerkt – die Prüfung startet erst mit „KI-Prüfung starten“ oben.",
  blocked:
    "KI-Prüfung läuft gerade – eine erneute Prüfung ist erst danach möglich.",
};

function claimAt(status: ClaimStatus): Claim {
  return {
    id: "clm_0001",
    text: "LLM-Reviews reduzieren die Reviewzeit.",
    claim_type: "quantitative_finding",
    status,
    briefing_anchor: "p1",
    provenance: {
      tool: "deep-research-x",
      model: "drx-1",
      extracted_at: "2026-08-20T08:00:00Z",
      search_path: "Lauf 1",
    },
    evidence: [],
    history: [
      {
        seq: 1,
        at: "2026-08-20T08:00:00Z",
        actor: "system:extraction",
        to_status: status,
        reason: "Testclaim.",
        prev_hash: "0".repeat(64),
        hash: "1".repeat(64),
      },
    ],
  } as unknown as Claim;
}

function markup(
  status: ClaimStatus,
  options: { activity?: { source: "run"; kind: string } } = {},
): string {
  const marker: ClaimMarkerVM = {
    claim: claimAt(status),
    evidenceNumbers: [],
    anchorDrifted: false,
  };
  const card = (
    <ClaimCard
      projectId="proj_test"
      marker={marker}
      routing={null}
      selected
      linked={false}
      selectedEvidenceId={null}
      evidenceDisplay={{}}
      currentSeconds={() => 0}
      onSelect={() => {}}
    />
  );
  if (!options.activity) {
    return renderToStaticMarkup(card);
  }
  return renderToStaticMarkup(
    <ProjectEventStreamContext.Provider
      value={{
        activity: options.activity as never,
        activeRun: null,
        connectionLost: false,
        subscribe: () => () => {},
      }}
    >
      {card}
    </ProjectEventStreamContext.Provider>,
  );
}

describe("ClaimCard re-run trigger (surface 1)", () => {
  it("carries the Copywriting Contract's Surface 1 copy verbatim", () => {
    expect({
      trigger: RECHECK_COPY.trigger,
      confirmHeading: RECHECK_COPY.confirmHeading,
      confirmBody1: RECHECK_COPY.confirmBody1,
      confirmBody2: RECHECK_COPY.confirmBody2,
      confirmBodyConfirmed: RECHECK_COPY.confirmBodyConfirmed,
      confirmBody4: RECHECK_COPY.confirmBody4,
      cta: RECHECK_COPY.cta,
      ctaPending: RECHECK_COPY.ctaPending,
      cancel: RECHECK_COPY.cancel,
      success: RECHECK_COPY.success,
      blocked: RECHECK_COPY.blocked("KI-Prüfung"),
    }).toEqual(CONTRACT);
  });

  it("renders the trigger on an eligible expanded card", () => {
    const html = markup("prechecked");
    expect(html).toContain(CONTRACT.trigger);
    // Idle state only: the confirm block appears on press, not on render.
    expect(html).not.toContain(CONTRACT.confirmHeading);
    expect(html).not.toContain(CONTRACT.success);
  });

  it("renders no trigger block at all on an ineligible claim", () => {
    // Not a disabled control with a tooltip — nothing.
    const html = markup("contested");
    expect(html).not.toContain(CONTRACT.trigger);
    expect(html).not.toContain(CONTRACT.confirmHeading);
  });

  it("disables the trigger and names the blocking activity while a run is live", () => {
    const html = markup("prechecked", {
      activity: { source: "run", kind: "verification" },
    });
    expect(html).toContain(CONTRACT.blocked);
    expect(html).toContain("text-amber-700");
    expect(html).toContain("disabled");
  });

  it("gates on any activity, not only on a verification run", () => {
    // The A-8 trap in the other direction: useStartGate("verification")
    // would report null for a verification run — the exact run that blocks
    // the request. Both kinds must block here.
    const html = markup("prechecked", {
      activity: { source: "run", kind: "extraction" },
    });
    expect(html).toContain(RECHECK_COPY.blocked("Aussagen-Erfassung"));
  });

  it("renders none of the framings the Copywriting Contract bans", () => {
    const html = [
      markup("prechecked"),
      markup("confirmed"),
      markup("auto_confirmed"),
      markup("prechecked", {
        activity: { source: "run", kind: "verification" },
      }),
    ].join("\n");
    // A re-run produces a NEW judgment. Framing it as an update, an
    // improvement or a loss is what makes an unexpected verdict change read
    // as a bug — or frightens a reviewer away from a safe, archived action.
    for (const banned of [
      "aktualisiert",
      "verbessert",
      "genauer",
      "geht verloren",
      "wird gelöscht",
      "unwiderruflich",
      "zuverlässig",
      "endgültig",
      "keine Sorge",
      "10,9",
      "%",
      "€",
    ]) {
      expect(html, `banned copy present: ${banned}`).not.toContain(banned);
    }
  });
});
