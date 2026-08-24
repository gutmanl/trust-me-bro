import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProjectEventStreamContext } from "@/app/lib/ProjectEventStream";
import type { ClaimMarkerVM } from "@/lib/pipeline";
import type {
  CalibrationSnapshot,
  Claim,
  ClaimStatus,
  CalibrationResult,
  SupportDegree,
} from "@/lib/register";
import { formatTimestamp } from "../../status-labels";
import { ClaimCard, RECHECK_COPY, SUPERSESSION_COPY } from "./ClaimCard";

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

/**
 * The Copywriting Contract's Surface 4 table, transcribed INDEPENDENTLY of
 * `SUPERSESSION_COPY` for the same reason `CONTRACT` exists above: an
 * assertion against the component's own constant follows a copy edit instead
 * of catching it.
 */
const SUPERSESSION_CONTRACT = {
  line1: (previousVerdictPhrase: string, formattedDate: string) =>
    `Die Vorprüfung kommt jetzt zu einem anderen Ergebnis – zuvor „${previousVerdictPhrase}“ am ${formattedDate}.`,
  line2: (m: number, k: number) =>
    `Diese Aussage wurde ${m}-mal vorgeprüft; dabei sind ${k} unterschiedliche Ergebnisse entstanden.`,
  disclosureSummary: "Was stand in der vorherigen Begründung?",
  vintagePresent: (version: string) =>
    `Erstellt unter Fassung ${version} des Bewertungsschemas.`,
  vintageAbsent:
    "Fassung des Bewertungsschemas nicht vermerkt – die Begründung stammt aus der Zeit vor dieser Aufzeichnung.",
};

/**
 * The subordinate register the note must render in, as it appears in the
 * markup. Asserting the whole attribute — not a substring of it — is what
 * makes „identical to the shipped judgment-supersession note" checkable:
 * an added `bg-`, `font-bold` or amber token fails here.
 *
 * The claims in this file carry no evidence, so no `EvidenceCard` renders
 * and the judgment note that shares this class cannot be the match.
 */
const NOTE_CLASS_ATTR =
  'class="mt-2 border-l-2 border-slate-200 pl-2 text-xs text-slate-500"';

interface Calibration {
  supportDegree?: SupportDegree;
  result?: CalibrationResult;
  reasoning?: string;
  archive?: CalibrationSnapshot[];
}

function claimAt(status: ClaimStatus, calibration: Calibration = {}): Claim {
  return {
    support_degree: calibration.supportDegree,
    calibration_result: calibration.result,
    calibration_reasoning: calibration.reasoning,
    previous_calibrations: calibration.archive,
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
  options: {
    activity?: { source: "run"; kind: string };
    calibration?: Calibration;
  } = {},
): string {
  const marker: ClaimMarkerVM = {
    claim: claimAt(status, options.calibration),
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

function snapshot(
  result: CalibrationResult,
  supersededAt: string,
  options: {
    supportDegree?: SupportDegree;
    reasoning?: string;
    promptVersion?: string;
  } = {},
): CalibrationSnapshot {
  return {
    support_degree: options.supportDegree ?? "supported",
    calibration_result: result,
    calibration_reasoning: options.reasoning,
    calibration_prompt_version: options.promptVersion,
    superseded_at: supersededAt,
  };
}

const SUPERSEDED_AT = "2026-08-21T09:00:00Z";

describe("ClaimCard verdict-changed note (surface 4)", () => {
  it("carries the Copywriting Contract's Surface 4 copy verbatim", () => {
    expect(SUPERSESSION_COPY.line1("stützt", "21. Aug. 2026, 11:00")).toBe(
      SUPERSESSION_CONTRACT.line1("stützt", "21. Aug. 2026, 11:00"),
    );
    expect(SUPERSESSION_COPY.line2(4, 2)).toBe(
      SUPERSESSION_CONTRACT.line2(4, 2),
    );
    expect(SUPERSESSION_COPY.disclosureSummary).toBe(
      SUPERSESSION_CONTRACT.disclosureSummary,
    );
    expect(SUPERSESSION_COPY.vintagePresent("1.0.0")).toBe(
      SUPERSESSION_CONTRACT.vintagePresent("1.0.0"),
    );
    expect(SUPERSESSION_COPY.vintageAbsent).toBe(
      SUPERSESSION_CONTRACT.vintageAbsent,
    );
  });

  it("renders no note at all on a claim with no archive", () => {
    const html = markup("prechecked", {
      calibration: { supportDegree: "supported", result: "licensed" },
    });
    // The class attribute must be absent from the markup entirely — not
    // merely carrying different text.
    expect(html).not.toContain(NOTE_CLASS_ATTR);
    expect(html).not.toContain(SUPERSESSION_CONTRACT.disclosureSummary);
  });

  it("renders no note when the re-run reached the same conclusion", () => {
    const html = markup("prechecked", {
      calibration: {
        supportDegree: "supported",
        result: "licensed",
        archive: [snapshot("licensed", SUPERSEDED_AT)],
      },
    });
    expect(html).not.toContain(NOTE_CLASS_ATTR);
  });

  it("names the previous verdict and its de-DE date on a changed verdict", () => {
    const html = markup("prechecked", {
      calibration: {
        supportDegree: "partially_supported",
        result: "weakened",
        archive: [
          snapshot("licensed", SUPERSEDED_AT, { supportDegree: "supported" }),
        ],
      },
    });
    // „stützt" is deriveVerdict(supported, licensed, false).phrase — the
    // exact words the chip used when this WAS the verdict.
    expect(html).toContain(
      SUPERSESSION_CONTRACT.line1("stützt", formatTimestamp(SUPERSEDED_AT)),
    );
    expect(html).toContain(NOTE_CLASS_ATTR);
    // One archived entry never reaches the depth threshold.
    expect(html).not.toContain("vorgeprüft; dabei sind");
  });

  it("falls back to the calibration label when the archived entry has no support degree", () => {
    const html = markup("prechecked", {
      calibration: {
        supportDegree: "supported",
        result: "weakened",
        archive: [
          {
            calibration_result: "licensed",
            superseded_at: SUPERSEDED_AT,
          },
        ],
      },
    });
    expect(html).toContain(
      SUPERSESSION_CONTRACT.line1(
        "freigegeben",
        formatTimestamp(SUPERSEDED_AT),
      ),
    );
    // NOT deriveVerdict's data-anomaly degradation, which is a statement
    // about the record rather than about the old verdict.
    expect(html).not.toContain("Vorprüfung unvollständig");
  });

  it("renders the depth line at three archived entries with two distinct results", () => {
    const html = markup("prechecked", {
      calibration: {
        supportDegree: "partially_supported",
        result: "weakened",
        archive: [
          snapshot("licensed", "2026-08-19T09:00:00Z"),
          snapshot("weakened", "2026-08-20T09:00:00Z"),
          snapshot("licensed", SUPERSEDED_AT),
        ],
      },
    });
    // M counts pre-checks (archive + current) = 4; K counts DISTINCT enum
    // values = 2, not the three archived entries.
    expect(html).toContain(SUPERSESSION_CONTRACT.line2(4, 2));
    expect(html).toContain(
      SUPERSESSION_CONTRACT.line1("stützt", formatTimestamp(SUPERSEDED_AT)),
    );
  });

  it("renders the stamp-present vintage line under the archived justification", () => {
    const html = markup("prechecked", {
      calibration: {
        supportDegree: "partially_supported",
        result: "weakened",
        archive: [
          snapshot("licensed", SUPERSEDED_AT, {
            reasoning: "Der Auszug stützt die Aussage im behaupteten Ausmaß.",
            promptVersion: "1.0.0",
          }),
        ],
      },
    });
    expect(html).toContain(SUPERSESSION_CONTRACT.disclosureSummary);
    expect(html).toContain(
      "Der Auszug stützt die Aussage im behaupteten Ausmaß.",
    );
    expect(html).toContain(SUPERSESSION_CONTRACT.vintagePresent("1.0.0"));
    expect(html).not.toContain(SUPERSESSION_CONTRACT.vintageAbsent);
    // Phase 02 integrity rule: archived prose is never clamped or truncated.
    expect(html).not.toContain("line-clamp");
    expect(html).not.toContain("truncate");
  });

  it("renders the stamp-absent vintage line when the archived entry carries no version", () => {
    const html = markup("prechecked", {
      calibration: {
        supportDegree: "partially_supported",
        result: "weakened",
        archive: [
          snapshot("licensed", SUPERSEDED_AT, {
            reasoning: "Aus einem älteren Prüflauf ohne Fassungsvermerk.",
          }),
        ],
      },
    });
    expect(html).toContain(SUPERSESSION_CONTRACT.vintageAbsent);
    expect(html).not.toContain("Erstellt unter Fassung");
  });

  it("renders no rate, no percentage and none of the banned framings", () => {
    // The whole point of the depth line is that it is a COUNT. A percentage
    // anywhere near it — above all the measured run-to-run flip rate — is
    // the strongest form of the overreliance risk this surface refuses.
    const html = markup("prechecked", {
      calibration: {
        supportDegree: "partially_supported",
        result: "weakened",
        archive: [
          snapshot("licensed", "2026-08-19T09:00:00Z", {
            reasoning: "Der Auszug stützt die Aussage im behaupteten Ausmaß.",
            promptVersion: "1.0.0",
          }),
          snapshot("weakened", "2026-08-20T09:00:00Z"),
          snapshot("licensed", SUPERSEDED_AT),
        ],
      },
    });
    expect(html).toContain(SUPERSESSION_CONTRACT.line2(4, 2));
    for (const banned of [
      "%",
      "10,9",
      "10.9",
      "Prozent",
      "€",
      "aktualisiert",
      "verbessert",
      "genauer",
      "geht verloren",
      "wird gelöscht",
      "unwiderruflich",
      "sicher",
      "eindeutig",
      "zuverlässig",
      "endgültig",
      "keine Sorge",
      ">Details<",
    ]) {
      expect(html, `banned copy present: ${banned}`).not.toContain(banned);
    }
  });
});
