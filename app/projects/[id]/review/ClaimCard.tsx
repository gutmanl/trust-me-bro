"use client";

import { useActionState, useState } from "react";

import {
  compactButtonClass,
  compactSecondaryButtonClass,
  ErrorBanner,
} from "@/app/components/ui";
import type {
  ClaimMarkerVM,
  ClaimRepairSuggestionVM,
  Evidence,
  EvidenceDisplay,
  MechanicalCapVM,
} from "@/lib/pipeline";
import type {
  CalibrationResult,
  CalibrationSnapshot,
  ClaimStatus,
  RoutingReason,
} from "@/lib/register";
import {
  classifyReasoningParagraph,
  reasoningRoleClassName,
  splitReasoningParagraphs,
} from "../../reasoning-paragraphs";
import {
  CALIBRATION_LABELS,
  CLAIM_TYPE_LABELS,
  formatModel,
  formatTimestamp,
  RELATION_LABELS,
  SOURCE_TYPE_LABELS,
  STATUS_LABELS,
  statusBadgeClassName,
  SUPPORT_LABELS,
} from "../../status-labels";
import {
  substituteVerdictProse,
  type VerdictProseEvidence,
} from "../../verdict-glossary";
import {
  deriveVerdict,
  relationBadgeClassName,
  verdictBadgeClassName,
} from "../../verdict-labels";
import type { RecheckFormState } from "./actions";
import { requestClaimRecheckAction } from "./actions";
import { activityLabel, useActivity } from "../RunStatusProvider";
import { deriveCalibrationSupersession } from "./calibration-supersession";
import {
  ClaimRepairSuggestionBox,
  RequestClaimRepairSuggestion,
} from "./ClaimRepairSuggestionBox";
import { ComplaintDialog } from "./ComplaintDialog";
import { deriveSupersededJudgments } from "./judgment-supersession";
import { RepairPanel, type ParagraphOption } from "./RepairPanel";
import { ROUTING_LABELS, routingSupersededByVerdict } from "./routing-labels";

/** German prose for the violated mechanical rule(s) — app-tier copy over
 * the structured VM, mirroring the label-map convention. */
function describeMechanicalCap(cap: MechanicalCapVM): string {
  const parts: string[] = [];
  for (const violation of cap.violations) {
    if (violation === "min_pertinent_sources") {
      parts.push(
        "Das Bewertungsschema verlangt für diesen Aussagetyp mindestens " +
          `${cap.rule.min_pertinent_sources} unabhängige einschlägige ` +
          `Quelle${cap.rule.min_pertinent_sources === 1 ? "" : "n"} – ` +
          `vorhanden: ${cap.pertinentSources}.`,
      );
    } else if (violation === "required_source_types_any") {
      parts.push(
        "Keine der einschlägigen Quellen hat einen der vom Schema " +
          "geforderten Quellentypen.",
      );
    } else if (violation === "min_source_type_diversity") {
      parts.push(
        "Die einschlägigen Quellen erreichen nicht die geforderte " +
          `Typenvielfalt (${cap.rule.min_source_type_diversity}).`,
      );
    } else {
      parts.push(
        "Alle einschlägigen Quellen fallen in Typen, die allein nicht " +
          "ausreichen.",
      );
    }
  }
  return parts.join(" ");
}

/**
 * A claim as a margin card beside its anchor paragraph. Collapsed: identity,
 * status, routing reason and the evidence numbers. Selected, it expands in
 * place to the full detail (TMB-34): Kernaussage, source, Beleg and
 * verbatim excerpt. The automatic pre-check (judgments, support degree,
 * calibration) is deliberately SUBORDINATE to the excerpt: collapsed below
 * it, expanded only on divergence, because LLM explanations invite
 * unwarranted deference.
 */
export function ClaimCard({
  projectId,
  marker,
  routing,
  queuedAt,
  selected,
  linked,
  selectedEvidenceId,
  evidenceDisplay,
  currentSeconds,
  onSelect,
  showAnchor = false,
  paragraphs,
  anchoredParagraph,
  repairSuggestion,
  mechanicalCap,
}: {
  projectId: string;
  marker: ClaimMarkerVM;
  routing: RoutingReason | null;
  queuedAt?: string;
  selected: boolean;
  linked: boolean;
  selectedEvidenceId: string | null;
  evidenceDisplay: Record<string, EvidenceDisplay>;
  currentSeconds: () => number;
  onSelect: (claimId: string, evidenceId?: string) => void;
  showAnchor?: boolean;
  /** The briefing's paragraphs, passed through to the repair panel's anchor
   * picker. */
  paragraphs?: ParagraphOption[];
  /** The paragraph this card sits beside, seeding the passage editor. */
  anchoredParagraph?: ParagraphOption;
  /** Open machine-generated repair suggestion for this claim
   * (verdict-driven repair) — rendered above the complaint dialog. */
  repairSuggestion?: ClaimRepairSuggestionVM;
  /** Why this claim's verdict is mechanically capped, when it is
   * (verdict-driven repair) — rendered inside the pre-check disclosure. */
  mechanicalCap?: MechanicalCapVM;
}) {
  const { claim } = marker;
  // The repair panel is reachable for a contested claim (all three repairs)
  // and for a claim whose anchor drifted (the two anchor repairs) — a
  // misplaced anchor is a defect in any status, not a verification verdict.
  const showRepair = claim.status === "contested" || marker.anchorDrifted;
  // Combined pre-check verdict (verdict redesign): one phrase from
  // support × calibration; divergence — where both enums stay unset by
  // construction — is detected from the evidence-level judgments.
  const divergent = claim.evidence.some(
    (evidence) => evidenceDisplay[`${claim.id}/${evidence.id}`]?.divergent,
  );
  const verdict = deriveVerdict(
    claim.support_degree,
    claim.calibration_result,
    divergent,
  );
  // Referents for the display-tier glossary, built here rather than passed
  // in from the server: `marker.evidenceNumbers` is positionally aligned
  // with `claim.evidence` by buildBriefingViewModel, and `evidenceDisplay`
  // is already keyed `${claimId}/${evidenceId}` — all three are already on
  // the card, so this costs no new prop, no new server computation and no
  // new barrel export. It lists ONLY this claim's evidence, which is what
  // makes an id belonging to another claim structurally unresolvable.
  const proseEvidence: VerdictProseEvidence[] = claim.evidence.map(
    (evidence, index) => ({
      id: evidence.id,
      number: marker.evidenceNumbers[index],
      citation: evidenceDisplay[`${claim.id}/${evidence.id}`]?.citation,
      verbatimExcerpt: evidence.verbatim_excerpt,
    }),
  );
  const lastReason = claim.history.at(-1)?.reason;
  return (
    <div
      id={`claim-card-${claim.id}`}
      className={`rounded-md border border-l-2 bg-white transition-colors ${
        selected
          ? "border-blue-300 border-l-blue-500"
          : linked
            ? "border-blue-200 border-l-blue-400"
            : "border-slate-200 border-l-slate-300"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(claim.id)}
        aria-expanded={selected}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-xs text-slate-500">{claim.id}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${statusBadgeClassName(claim.status)}`}
        >
          {STATUS_LABELS[claim.status]}
        </span>
        {verdict ? (
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${verdictBadgeClassName(verdict.severity)}`}
          >
            {verdict.phrase}
          </span>
        ) : null}
        {routing && !routingSupersededByVerdict(routing, verdict) ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
            {ROUTING_LABELS[routing]}
          </span>
        ) : null}
        {marker.anchorDrifted ? (
          // The explanation is visually-hidden text rather than a `title`:
          // a tooltip only exists for a pointer that hovers it, and this is
          // the badge that tells a reviewer the position beside the text is
          // a guess.
          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-800">
            Textstelle verschoben
            <span className="sr-only">
              {" "}
              – der zitierte Wortlaut steht nicht mehr an der Stelle, auf die
              die Textstelle zeigt; die Position ist nur noch geschätzt.
            </span>
          </span>
        ) : null}
        <span className="ml-auto text-xs text-slate-400">
          {selected ? "▴" : "▾"}
        </span>
      </button>

      {selected ? (
        <div className="space-y-4 border-t border-slate-100 px-3 pt-3 pb-3">
          <div>
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Kernaussage
            </h3>
            <p className="mt-1 text-sm text-slate-800">{claim.text}</p>
          </div>

          {claim.evidence.length === 0 ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Ohne Beleg erfasst – für diese Aussage wurde keine Quelle zitiert.
            </p>
          ) : (
            claim.evidence.map((evidence, index) => (
              <EvidenceCard
                key={evidence.id}
                evidence={evidence}
                number={marker.evidenceNumbers[index]}
                display={evidenceDisplay[`${claim.id}/${evidence.id}`]}
                highlighted={evidence.id === selectedEvidenceId}
                proseEvidence={proseEvidence}
              />
            ))
          )}

          {claim.support_degree || claim.calibration_result ? (
            <details className="rounded-md border border-slate-200">
              {/* A summary labelled „Details" tells the reviewer nothing
                  about what they will find. A question tells them what the
                  disclosure answers, and it frames the content as the
                  machine's account rather than as the fact of the matter. */}
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-600">
                Wie hat die KI diese Aussage vorgeprüft?
              </summary>
              <dl className="space-y-1 px-3 pb-3 text-xs text-slate-700">
                {/* First, because the rubric rule that decided the verdict is
                    keyed on exactly this value (se-evidence-rubric-v1.json
                    `claim_types`) — the two rows below therefore read as its
                    consequences rather than as unrelated verdicts. It sits
                    inside the disclosure, so a claim that has not been
                    pre-checked shows no type: that is deliberate, and a fifth
                    always-visible chip would work against the subordination
                    the component's header comment describes. */}
                <div>
                  <dt className="inline text-slate-500">Aussagetyp: </dt>
                  <dd className="inline">
                    {CLAIM_TYPE_LABELS[claim.claim_type]}
                  </dd>
                </div>
                {claim.support_degree ? (
                  <div>
                    <dt className="inline text-slate-500">
                      Unterstützungsgrad:{" "}
                    </dt>
                    <dd className="inline">
                      {SUPPORT_LABELS[claim.support_degree]}
                    </dd>
                  </div>
                ) : null}
                {claim.calibration_result ? (
                  <div>
                    <dt className="inline text-slate-500">
                      Bewertung (Schema):{" "}
                    </dt>
                    <dd className="inline">
                      {CALIBRATION_LABELS[claim.calibration_result]}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {/* Verdict-driven repair: the cap that decided this verdict.
                  Without this line the card shows a „abschwächen"-verdict
                  beside prose that may say no weakening is needed — the
                  mechanical rule is the missing third voice, and it also
                  says what actually unlocks the claim. */}
              {mechanicalCap !== undefined &&
              claim.calibration_result === "weakened" ? (
                <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
                  <span className="font-medium">Mechanisch begrenzt: </span>
                  {describeMechanicalCap(mechanicalCap)} Eine Umformulierung
                  kann dieses Urteil nicht anheben – es braucht weitere Belege
                  oder Ihre Entscheidung in der Adjudikation.
                </p>
              ) : null}
              {/* Between the enum rows and the CURRENT reasoning, never in
                  the header row above: the header is where the status,
                  verdict, routing and anchor chips live, and this must never
                  sit on one line with them. It is a paragraph in the
                  subordinate slate register, not a chip — a redundant
                  claim-card chip was deliberately removed on 2026-08-20 and
                  re-adding one here would undo that. */}
              <CalibrationSupersededNote
                previousCalibrations={claim.previous_calibrations}
                currentResult={claim.calibration_result}
                proseEvidence={proseEvidence}
              />
              {claim.calibration_reasoning ? (
                <div className="space-y-1 border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
                  <ReasoningProse
                    reasoning={claim.calibration_reasoning}
                    evidence={proseEvidence}
                  />
                </div>
              ) : null}
            </details>
          ) : null}

          {/* The reason string is glossed too: run-verification.ts added its
              SUPPORT_DEGREE_DE / CALIBRATION_RESULT_DE maps only later, so
              historical entries in existing registers still carry a raw
              support-degree token inside their German prose. Same
              remediation, same corpus. */}
          <p className="text-xs break-words text-slate-400">
            {queuedAt
              ? `In der Warteschlange seit ${formatTimestamp(queuedAt)}. `
              : ""}
            {lastReason === undefined
              ? null
              : substituteVerdictProse(lastReason, proseEvidence)}
          </p>

          {/* Verdict-driven repair: the machine's proposal sits ABOVE the
              complaint dialog — it answers the same question the reviewer is
              about to decide — but never replaces it: confirm and complain
              stay exactly where they were. */}
          {claim.status === "pending_adjudication" &&
          repairSuggestion !== undefined ? (
            <ClaimRepairSuggestionBox
              projectId={projectId}
              claimId={claim.id}
              suggestion={repairSuggestion}
            />
          ) : null}
          {claim.status === "pending_adjudication" &&
          repairSuggestion === undefined &&
          (routing === "negative_precheck" ||
            routing === "existence_check_failed") ? (
            <RequestClaimRepairSuggestion
              projectId={projectId}
              claimId={claim.id}
              capped={mechanicalCap !== undefined}
            />
          ) : null}
          {claim.status === "pending_adjudication" ? (
            <ComplaintDialog
              projectId={projectId}
              claim={claim}
              currentSeconds={currentSeconds}
            />
          ) : null}

          {showRepair ? (
            <RepairPanel
              projectId={projectId}
              claim={claim}
              paragraphs={paragraphs}
              anchoredParagraph={anchoredParagraph}
            />
          ) : null}

          {claim.status === "revised" ? (
            <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              Überarbeitet – die Neufassung durchläuft die betroffenen
              Prüfstufen in der nächsten KI-Prüfung.
            </p>
          ) : null}

          <RecheckClaimControl projectId={projectId} claim={claim} />
        </div>
      ) : (
        <div className="px-3 pb-2">
          <p className="line-clamp-2 text-xs text-slate-600">{claim.text}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {claim.evidence.length === 0 ? (
              <span className="text-xs text-slate-400">ohne Beleg</span>
            ) : (
              marker.evidenceNumbers.map((number, index) => (
                <button
                  key={number}
                  type="button"
                  onClick={() => onSelect(claim.id, claim.evidence[index]?.id)}
                  className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-xs text-blue-700 hover:bg-blue-100"
                >
                  [{number}]
                </button>
              ))
            )}
            {showAnchor ? (
              <span className="text-xs text-slate-400">
                Anker: {claim.briefing_anchor}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The subordinate register Phase 02 established for „a machine changed its
 * mind here": a slate left rule, small text, no fill, no icon, no bold.
 *
 * Single-sourced rather than repeated inline because two notes now use it —
 * the per-backend judgment note in `EvidenceCard` and the per-claim
 * calibration note below. They must stay visually identical: the whole
 * reason this register works is that it reads as an aside everywhere it
 * appears. A copy of the string that drifts turns one of them into a
 * different kind of thing.
 */
const SUBORDINATE_NOTE_CLASS =
  "mt-2 border-l-2 border-slate-200 pl-2 text-xs text-slate-500";

/**
 * The Copywriting Contract's Surface 4 table, transcribed. Same reason as
 * `RECHECK_COPY`: named so the test can assert rendered markup against an
 * independent transcription of the same approved table.
 *
 * `line2` needs no singular/plural ternary, and its absence is not an
 * oversight: the depth line renders only at two or more archived entries and
 * two or more distinct results, so `preCheckCount` is at least 3 and
 * `distinctResultCount` at least 2 by construction. A dead ternary would
 * suggest a reachable singular that does not exist.
 */
export const SUPERSESSION_COPY = {
  line1: (previousVerdictPhrase: string, formattedDate: string) =>
    "Die Vorprüfung kommt jetzt zu einem anderen Ergebnis – zuvor " +
    `„${previousVerdictPhrase}“ am ${formattedDate}.`,
  line2: (preCheckCount: number, distinctResultCount: number) =>
    `Diese Aussage wurde ${preCheckCount}-mal vorgeprüft; dabei sind ` +
    `${distinctResultCount} unterschiedliche Ergebnisse entstanden.`,
  disclosureSummary: "Was stand in der vorherigen Begründung?",
  vintagePresent: (version: string) =>
    `Erstellt unter Fassung ${version} des Bewertungsschemas.`,
  vintageAbsent:
    "Fassung des Bewertungsschemas nicht vermerkt – die Begründung stammt " +
    "aus der Zeit vor dieser Aufzeichnung.",
} as const;

/**
 * Surface 4 (RERUN-05, D-14): when this claim's pre-check has reached a
 * different conclusion than it did before, say so — naming the previous
 * verdict and the date it was superseded, with the archived justification
 * one question away.
 *
 * What it deliberately does NOT do: quantify. Re-running an identical prompt
 * over a borderline claim reaches a different verdict a measurable fraction
 * of the time, so a „verdict changed" note can fire with no new information
 * behind it. The honest answer to that is the depth line — a plain count of
 * how often THIS claim has moved, which is per-claim evidence a reviewer can
 * act on — and NOT a rate. A standing percentage on the card would be the
 * strongest form of the overreliance risk the anti-features table exists to
 * refuse, and the measured figure is a borderline-corpus upper bound under
 * templates no project runs. It belongs in the thesis prose. Nothing here
 * states how much to trust anything.
 *
 * Nor is there a standing „this may not reproduce" caveat on every changed
 * verdict: D-14 rejects it explicitly — it edges into trust signalling and
 * becomes wallpaper. The depth line is the per-claim mechanism; the general
 * statement lives in the transient post-run summary.
 */
function CalibrationSupersededNote({
  previousCalibrations,
  currentResult,
  proseEvidence,
}: {
  previousCalibrations: readonly CalibrationSnapshot[] | undefined;
  currentResult: CalibrationResult | undefined;
  proseEvidence: readonly VerdictProseEvidence[];
}) {
  const superseded = deriveCalibrationSupersession(
    previousCalibrations,
    currentResult,
  );
  if (superseded === null) {
    // No archive, or a re-run that reached the same conclusion: nothing at
    // all. No placeholder, no „unverändert" line, no zero state.
    return null;
  }
  const { previous } = superseded;
  // The previous verdict in the words the chip used when it WAS the verdict
  // — anything else would give the reviewer two vocabularies for one thing.
  // `divergent` is false because divergence is not archived: it is derived
  // per render from the evidence-level judgments and has no snapshot field.
  // When the archived entry carries no support degree, deriveVerdict would
  // degrade to „Vorprüfung unvollständig", which is a statement about the
  // DATA, not the old verdict — so the raw calibration label is the honest
  // fallback there.
  const previousPhrase =
    previous.support_degree === undefined
      ? CALIBRATION_LABELS[previous.calibration_result]
      : (deriveVerdict(
          previous.support_degree,
          previous.calibration_result,
          false,
        )?.phrase ?? CALIBRATION_LABELS[previous.calibration_result]);
  return (
    <div className="px-3 pb-1">
      {superseded.changed ? (
        <p className={SUBORDINATE_NOTE_CLASS}>
          {SUPERSESSION_COPY.line1(
            previousPhrase,
            formatTimestamp(previous.superseded_at),
          )}
        </p>
      ) : null}
      {superseded.showDepth ? (
        <p className={SUBORDINATE_NOTE_CLASS}>
          {SUPERSESSION_COPY.line2(
            superseded.preCheckCount,
            superseded.distinctResultCount,
          )}
        </p>
      ) : null}
      {previous.calibration_reasoning ? (
        // RECORDED, not silently accepted: this is the phase's one
        // second-level disclosure, and it stands against Phase 02's rule
        // that the technical justification is never more than one
        // disclosure level deep. The argument for it is that the rule
        // governs the CURRENT justification — which is unaffected, still
        // exactly one level down — while this prose is historical, and the
        // alternative of rendering it inline beside the current reasoning
        // puts two machine opinions in one slot competing for the same
        // reading. That argument is sound but it is an interpretation, not
        // a shipped rule. The overturn path if it is rejected: move the
        // archived prose to the Verlauf page, at the cost of D-14's
        // „reachable from the card", which is what makes „what would
        // overturn this verdict" answerable without leaving the card.
        //
        // Summary phrased as the question it answers, per this file's own
        // rule a few blocks up — „Details" would tell the reviewer nothing.
        <details className="mt-2 border-l-2 border-slate-200 pl-2">
          <summary className="cursor-pointer text-xs text-slate-500">
            {SUPERSESSION_COPY.disclosureSummary}
          </summary>
          <div className="mt-1 space-y-1 text-xs break-words text-slate-600">
            {/* Through the SAME renderer as the current reasoning, so the
                glossary substitution and evidence-id resolution apply to
                the archived prose too. Never clamped and never truncated:
                a justification the reviewer cannot read in full is worth
                less than the click it cost. */}
            <ReasoningProse
              reasoning={previous.calibration_reasoning}
              evidence={proseEvidence}
            />
            <p className="text-slate-400">
              {previous.calibration_prompt_version === undefined
                ? SUPERSESSION_COPY.vintageAbsent
                : SUPERSESSION_COPY.vintagePresent(
                    previous.calibration_prompt_version,
                  )}
            </p>
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Claim statuses on which the re-run trigger is offered.
 *
 * A display-tier mirror of the pipeline's `RECHECK_STATUSES`, which stays
 * internal on purpose — the app tier may ASK for a re-check, never decide
 * who qualifies for one. This list therefore governs only the affordance:
 * `requestClaimRecheck` re-derives eligibility itself, inside the register
 * transaction, and a claim that moved in between is skipped there. A drift
 * between the two lists can hide or offer a button, never mis-move a claim.
 */
const RECHECK_ELIGIBLE_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  "existence_checked",
  "prechecked",
  "auto_confirmed",
  "confirmed",
]);

/**
 * Whether the expanded card offers „Prüfung erneut ausführen" (RERUN-01).
 *
 * The four statuses above mirror `RECHECK_STATUSES`. The fifth source
 * status, `pending_adjudication`, was admitted when 04-03 widened the
 * transition gate, and RERUN-01 names it explicitly: „including claims
 * queued for adjudication". A claim the machine could not decide is the one
 * a reviewer is MOST likely to want re-checked, so leaving it out left the
 * requirement's own wording undelivered on this surface.
 *
 * The gate's condition is duplicated here rather than imported because this
 * is a client component and `app/**` cannot runtime-import the pipeline
 * barrel. That is safe in the direction it can fail: this predicate only
 * decides whether a BUTTON is drawn. The server re-derives the real gate
 * inside the transaction, so a mirror that is a shade too generous costs a
 * verbatim German refusal in the confirm block, never a wrong write. The
 * shade it can be too generous by is exactly the gate's stated blind spot —
 * a claim parked before the routing extension existed carries no routing
 * and both sides reject it alike.
 */
export function offersRecheck(claim: ClaimMarkerVM["claim"]): boolean {
  // CR-01. Mirrors `canLeaveRecheck`: the single edge back out of
  // `recheck_required` is gated on evidence, so a claim with none would be
  // admitted and then stranded there forever. This is NOT the
  // too-generous-is-safe case the comment above describes — the server does
  // refuse it, but only after the button has invited the reviewer to press
  // it, and on the zero-evidence claims of the adjudication queue that is
  // the most inviting button on the card.
  //
  // The atomicity half of the real gate is deliberately NOT mirrored: it
  // lives in `isAtomicClaimText`, which this client component cannot
  // runtime-import, and THAT residue is the safe direction — a shade too
  // generous costs a verbatim German refusal, never a wrong write.
  if (claim.evidence.length === 0) {
    return false;
  }
  if (RECHECK_ELIGIBLE_STATUSES.has(claim.status)) {
    return true;
  }
  return (
    claim.status === "pending_adjudication" &&
    claim.history.at(-1)?.routing !== undefined
  );
}

const initialRecheckState: RecheckFormState = { error: null };

/**
 * The Copywriting Contract's Surface 1 table, transcribed.
 *
 * As a named map rather than inline JSX strings so `ClaimCard.test.tsx` can
 * assert the rendered markup against the same constants: a wording drift
 * then fails a test instead of shipping silently.
 */
export const RECHECK_COPY = {
  trigger: "Prüfung erneut ausführen",
  confirmHeading: "Diese Aussage erneut prüfen?",
  confirmBody1:
    "Die Prüfung beginnt wieder bei der Zitatprüfung (Stufe 1) und " +
    "durchläuft danach die KI-Prüfstufen erneut.",
  confirmBody2:
    "Die bisherige Bewertung und ihre Begründung werden überschrieben und " +
    "archiviert – sie bleiben auf dieser Karte lesbar.",
  confirmBodyConfirmed:
    "Die Bestätigung entfällt dabei und muss danach erneut erfolgen.",
  confirmBody4: "Das Ergebnis kann von der bisherigen Bewertung abweichen.",
  cta: "Erneut prüfen",
  ctaPending: "Wird vorgemerkt …",
  cancel: "Abbrechen",
  success:
    "Zur Nachprüfung vorgemerkt – die Prüfung startet erst mit " +
    "„KI-Prüfung starten“ oben.",
  blocked: (activity: string) =>
    `${activity} läuft gerade – eine erneute Prüfung ist erst danach möglich.`,
} as const;

/**
 * Surface 1 of the re-verification contract: „Prüfung erneut ausführen" on
 * the expanded card, as its last block and in the quiet secondary register.
 *
 * It is deliberately not in the collapsed header and deliberately not a
 * filled button: for a claim awaiting adjudication the human decision must
 * stay the visually first and heaviest action on the card.
 *
 * There is no typed forcing step here, on purpose. One claim, archived not
 * destroyed, one press to undo by re-running again — friction spent where
 * it buys nothing is what teaches a reviewer to type past it where it does.
 * The forcing step is spent once, on the project-wide sweep.
 */
function RecheckClaimControl({
  projectId,
  claim,
}: {
  projectId: string;
  claim: ClaimMarkerVM["claim"];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    requestClaimRecheckAction.bind(null, projectId, claim.id),
    initialRecheckState,
  );
  // Gated on the project's ACTIVITY, not on useStartGate("verification"):
  // that hook reports blockedBy null for a run of its own kind by design,
  // so gating on the verification kind would leave this trigger enabled
  // during exactly the run that makes the request impossible — and hand
  // the reviewer an avoidable RunActiveError instead of an explanation.
  const activity = useActivity();

  // WR-05: BEFORE the eligibility guard, deliberately.
  //
  // requestClaimRecheckAction calls revalidatePath(`/projects/${projectId}`)
  // before returning { requested: true }, and the page is force-dynamic, so
  // React applies the new action state and the refreshed RSC tree in the
  // same commit. By the time state.requested is true the claim already
  // carries `recheck_required` — which is not in RECHECK_ELIGIBLE_STATUSES
  // and has no routing branch — so with the guard first, offersRecheck was
  // false and the whole block returned null. The observable behaviour was:
  // press „Erneut prüfen", the block silently disappears, nothing is said.
  // ClaimCard has no notice for recheck_required either, so the reviewer
  // got no confirmation at all. RECHECK_COPY.success was asserted only as a
  // constant, never as rendered markup, which is why the suite was green.
  //
  // Conditioned on the new status rather than on state alone, so the
  // claim's own status is what clears the message: the next action that
  // moves the claim on takes the notice with it.
  if (state.requested === true && claim.status === "recheck_required") {
    return (
      <div className="border-t border-slate-200 pt-3">
        <p className="text-xs text-slate-500">{RECHECK_COPY.success}</p>
      </div>
    );
  }

  if (!offersRecheck(claim)) {
    // Absent, not disabled-with-a-tooltip: ineligibility here is a property
    // of where the claim stands, not a temporary obstacle, and a control
    // that can never become pressable is noise on an already dense card.
    return null;
  }

  if (activity) {
    // The one case that IS rendered disabled rather than absent: it is
    // temporary, so it has to be explained. Visible text, never a `title`
    // alone — a tooltip only exists for a pointer that hovers it.
    return (
      <div className="space-y-1 border-t border-slate-200 pt-3">
        <button type="button" disabled className={compactSecondaryButtonClass}>
          {RECHECK_COPY.trigger}
        </button>
        <p className="text-xs text-amber-700">
          {RECHECK_COPY.blocked(activityLabel(activity))}
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="border-t border-slate-200 pt-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={compactSecondaryButtonClass}
        >
          {RECHECK_COPY.trigger}
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-slate-200 pt-3">
      <form
        action={formAction}
        className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs"
      >
        <p className="font-medium text-slate-800">
          {RECHECK_COPY.confirmHeading}
        </p>
        <p className="text-slate-600">{RECHECK_COPY.confirmBody1}</p>
        <p className="text-slate-600">{RECHECK_COPY.confirmBody2}</p>
        {claim.status === "confirmed" || claim.status === "auto_confirmed" ? (
          <p className="text-slate-600">{RECHECK_COPY.confirmBodyConfirmed}</p>
        ) : null}
        <p className="text-slate-600">{RECHECK_COPY.confirmBody4}</p>
        <ErrorBanner message={state.error} />
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className={compactButtonClass}
          >
            {pending ? RECHECK_COPY.ctaPending : RECHECK_COPY.cta}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setOpen(false)}
            className={compactSecondaryButtonClass}
          >
            {RECHECK_COPY.cancel}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * The one place stored verdict prose is transformed for display.
 *
 * Order is load-bearing: substitute FIRST, split second. One pass over the
 * whole string means the quote-run segmentation sees the complete quote
 * structure, so a refusal is a whole-string refusal rather than a
 * per-paragraph lottery. Role markers are German words at paragraph start
 * and cannot collide with snake_case keys or evidence ids, which is what
 * makes rewriting-before-splitting safe.
 *
 * This is also the LAST place the text may be transformed. `claim` is handed
 * to `RepairPanel` a few lines above, whose form posts text into
 * `applyRepair` and the append-only chain — Germanizing anything upstream of
 * this component would persist display copy into the register. Prose is
 * rendered as React text children, never as markup: no
 * `dangerouslySetInnerHTML`, no Markdown renderer, no sanitizer.
 */
function ReasoningProse({
  reasoning,
  evidence,
}: {
  reasoning: string;
  evidence: readonly VerdictProseEvidence[];
}) {
  return (
    <>
      {splitReasoningParagraphs(
        substituteVerdictProse(reasoning, evidence),
      ).map((paragraph, index) => (
        <p
          key={index}
          className={reasoningRoleClassName(
            classifyReasoningParagraph(paragraph),
          )}
        >
          {paragraph}
        </p>
      ))}
    </>
  );
}

function EvidenceCard({
  evidence,
  number,
  display,
  highlighted,
  proseEvidence,
}: {
  evidence: Evidence;
  number: number | undefined;
  display: EvidenceDisplay | undefined;
  highlighted: boolean;
  proseEvidence: readonly VerdictProseEvidence[];
}) {
  const sourceTypeLabel =
    display &&
    SOURCE_TYPE_LABELS[display.sourceType as keyof typeof SOURCE_TYPE_LABELS];
  return (
    <div
      className={`rounded-md border p-3 ${
        highlighted ? "border-blue-300 bg-blue-50/40" : "border-slate-200"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-slate-700">
          {number !== undefined ? (
            <span className="mr-1 font-mono text-blue-700">[{number}]</span>
          ) : null}
          {display?.citation ?? evidence.source_id}
        </p>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
          {sourceTypeLabel ?? display?.sourceType}
        </span>
      </div>

      <p className="mt-2 text-xs text-slate-600">
        <span className="font-semibold text-slate-500">Beleg: </span>
        {display?.locatorText || "ohne Angabe"}
        {display?.snapshotHref ? (
          <>
            {" · "}
            <a
              href={display.snapshotHref}
              target="_blank"
              rel="noreferrer"
              className="text-blue-700 underline decoration-blue-300 hover:decoration-blue-600"
            >
              In der eingefrorenen Fassung öffnen
            </a>
          </>
        ) : null}
      </p>

      <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3">
        <p className="text-xs font-semibold text-slate-500">
          Wortlaut aus der Quelle
        </p>
        <p className="mt-1 text-sm text-slate-800">
          „{evidence.verbatim_excerpt}“
        </p>
        {evidence.existence_check ? (
          <p
            className={`mt-2 text-xs ${
              evidence.existence_check.status === "passed"
                ? "text-green-700"
                : "text-red-700"
            }`}
          >
            Zitatprüfung:{" "}
            {evidence.existence_check.status === "passed"
              ? "bestanden"
              : "nicht bestanden"}
          </p>
        ) : null}
      </div>

      {evidence.judgments.length > 0 ? (
        <details className="mt-2" open={display?.divergent}>
          <summary className="cursor-pointer text-xs font-medium text-slate-600">
            Wie hat die KI diesen Beleg bewertet? ({evidence.judgments.length}{" "}
            Urteil(e))
            {display?.divergent ? (
              <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-red-800">
                Divergenz
              </span>
            ) : evidence.relation_type ? (
              <span
                className={`ml-2 rounded-full px-2 py-0.5 ${relationBadgeClassName(evidence.relation_type)}`}
              >
                {RELATION_LABELS[evidence.relation_type]}
              </span>
            ) : null}
          </summary>
          {/* A backend revising ITSELF. Cross-backend disagreement is
              divergence and is already reported by the chip above; this note
              must not duplicate it. It states what changed and when, and
              nothing about which of the two judgments is better — that is the
              reviewer's call, and it is the call this tool exists to support.
              No disclosure around it: the surrounding details already is the
              card's one disclosure level. */}
          {deriveSupersededJudgments(evidence.judgments).map((superseded) => (
            <p
              key={`${superseded.backend}-${superseded.previousAt}`}
              className={SUBORDINATE_NOTE_CLASS}
            >
              {superseded.backend} hat das Urteil geändert – zuvor „
              {RELATION_LABELS[superseded.previousRelation]}“ am{" "}
              {formatTimestamp(superseded.previousAt)}.
            </p>
          ))}
          <ul className="mt-2 space-y-2">
            {evidence.judgments.map((judgment, index) => (
              <li
                key={`${judgment.backend}-${judgment.at}-${index}`}
                className="rounded-md border border-slate-200 p-2 text-xs"
              >
                <p className="font-medium text-slate-700">
                  <span
                    className={`rounded-full px-2 py-0.5 ${relationBadgeClassName(judgment.relation_type)}`}
                  >
                    {RELATION_LABELS[judgment.relation_type]}
                  </span>{" "}
                  · {Math.round(judgment.confidence * 100)} %
                  <span className="ml-2 font-normal text-slate-500">
                    {judgment.backend} ({formatModel(judgment.model)})
                  </span>
                </p>
                <div className="mt-1 space-y-1 text-slate-600">
                  <ReasoningProse
                    reasoning={judgment.reasoning}
                    evidence={proseEvidence}
                  />
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
