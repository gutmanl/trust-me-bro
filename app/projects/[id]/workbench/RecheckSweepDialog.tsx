"use client";

import { useActionState, useEffect, useState } from "react";

import { Modal } from "@/app/components/Modal";
import {
  compactInputClass,
  ErrorBanner,
  focusRingClass,
  primaryButtonClass,
} from "@/app/components/ui";
import type {
  RecheckPreview,
  RecheckScope,
  RecheckRungPreview,
} from "@/lib/pipeline";
import type { SweepFormState } from "./actions";
import { requestClaimRecheckSweepAction } from "./actions";

/**
 * Surfaces 2 + 3 of the re-verification contract: the confirmation the
 * project-wide sweep goes through.
 *
 * THE WHOLE POINT OF THIS FILE IS THAT IT IS SLOW TO GET THROUGH. The
 * ROADMAP is explicit that a bare count „produces automatic agreement and
 * is a useless confirmation", so this dialog itemises — total, the queued
 * sub-count, the confirmed sub-count on the rung that un-confirms, and an
 * exclusions line naming every skipped group — and then asks the reviewer
 * to type the number that is actually at risk before the submit becomes
 * pressable.
 *
 * Buçinca et al. (CSCW 2021) found cognitive forcing functions were the
 * only designs that reduced overreliance, and that users rated them LEAST
 * likeable. A complaint that typing the number is annoying is therefore the
 * predicted response to a working mitigation, not a defect report; it may
 * only ever be acted on by making the number easier to FIND, never by
 * removing the step.
 *
 * Nothing here is red and nothing here says anything is lost. After the
 * archive (D-01/D-02) the previous outcome stays readable on the claim's
 * own card, and destructive styling would assert the very thing this phase
 * removed.
 */

/**
 * The Copywriting Contract's Surfaces 2 + 3 table, transcribed.
 *
 * A named map rather than inline JSX strings so the SSR test can assert the
 * rendered markup against the same constants — a wording drift then fails a
 * test instead of shipping silently.
 *
 * Every full sentence pluralises through the ternary idiom. The „Aussage(n)"
 * shorthand that exists on older chips is banned in new copy, so the verb
 * agrees too („1 Aussage WIRD", „3 Aussagen WERDEN").
 */
export const SWEEP_COPY = {
  trigger: "Mehrere Aussagen erneut prüfen …",
  title: "Mehrere Aussagen erneut prüfen",
  intro:
    "Erneut geprüfte Aussagen durchlaufen alle Prüfstufen noch einmal – " +
    "beginnend bei der Zitatprüfung (Stufe 1).",
  ladderLegend: "Umfang",
  itemisationHeading: "Betroffen",
  total: (n: number): string =>
    `${n} Aussage${n === 1 ? "" : "n"} ${n === 1 ? "wird" : "werden"} ` +
    "erneut geprüft",
  queued: (q: number): string =>
    `davon ${q} in der Warteschlange zur manuellen Überprüfung`,
  confirmed: (c: number): string => `davon ${c} bereits bestätigt`,
  exclusionOpen: (o: number): string => `${o} gerade geöffnet`,
  exclusionDiscarded: (d: number): string => `${d} verworfen`,
  exclusionLegacy: (l: number): string =>
    `${l} ohne maschinellen Einordnungsvermerk (aus älteren Prüfläufen)`,
  exclusionsPrefix: "Nicht einbezogen: ",
  consequencesHeading: "Was dabei passiert",
  consequence1:
    "Die bisherige Bewertung und Begründung jeder betroffenen Aussage " +
    "werden überschrieben und archiviert – sie bleiben auf der jeweiligen " +
    "Karte lesbar.",
  consequence2: "Die Ergebnisse können von den bisherigen abweichen.",
  consequence3:
    "Die Prüfung läuft über die lokalen KI-Werkzeuge und beansprucht bei " +
    "vielen Aussagen erhebliche Zeit; sie lässt sich in der Statusleiste " +
    "pausieren und abbrechen.",
  consequence4:
    "Vorgemerkt wird jetzt – geprüft wird erst mit „KI-Prüfung starten“.",
  forcingLabelQueued:
    "Zur Bestätigung: Wie viele der betroffenen Aussagen stehen in der " +
    "Warteschlange zur manuellen Überprüfung?",
  forcingLabelTotal:
    "Zur Bestätigung: Wie viele Aussagen werden erneut geprüft?",
  forcingMismatch: "Die Zahl stimmt nicht mit der Aufstellung überein.",
  cta: (n: number): string => `Erneut prüfen (${n})`,
  ctaPending: "Wird vorgemerkt …",
  cancel: "Abbrechen",
  emptyHeading: "Für diesen Umfang kommt keine Aussage infrage.",
  emptyBody:
    "Alle Vorprüfungen dieses Projekts entsprechen bereits der aktuellen " +
    "Fassung des Bewertungsschemas. Über „Alle vorgeprüften Aussagen“ " +
    "lässt sich trotzdem erneut prüfen.",
} as const;

/**
 * The three rungs, in escalation order, with the labels and hints the
 * Copywriting Contract fixes.
 *
 * Transcribed here rather than imported from the pipeline's `RECHECK_SCOPES`
 * on purpose: the runtime list is an encoding, this is display copy, and the
 * two drift for different reasons. The English `value` strings are the enum
 * values the server validates — never translated.
 */
export const RECHECK_RUNGS: readonly {
  value: RecheckScope;
  label: string;
  hint: string;
}[] = [
  {
    value: "stale",
    label: "Nur veraltete Vorprüfungen",
    hint:
      "Aussagen, deren Vorprüfung unter einer anderen Fassung des " +
      "Bewertungsschemas entstanden ist.",
  },
  {
    value: "all",
    label: "Alle vorgeprüften Aussagen",
    hint:
      "Auch Aussagen, deren Vorprüfung bereits der aktuellen Fassung " +
      "entspricht.",
  },
  {
    value: "all_including_confirmed",
    label: "Auch bestätigte Aussagen",
    hint:
      "Bestätigte Aussagen kehren in die Prüfung zurück; ihre Bestätigung " +
      "entfällt und muss danach erneut erfolgen.",
  },
];

/** One rung as the dialog displays it: the server's preview with the claim
 * the reviewer has open SINCE the preview was computed taken back out. */
export interface RecheckRungView {
  total: number;
  queued: number;
  confirmed: number;
  excludedOpen: number;
  excludedDiscarded: number;
  excludedLegacy: number;
}

/**
 * The displayed numbers for one rung (RERUN-04's client half).
 *
 * The preview is fetched server-side without any exclusion, because the
 * claim the reviewer has expanded is client state that changes with no
 * round trip. Subtracting it here — rather than re-fetching per selection —
 * is what keeps the number on the button identical to the number the submit
 * acts on: the same id goes into `excludeClaimIds`, and the transaction
 * re-derives the same predicate.
 *
 * WHY „confirmed" IS DERIVED FROM THE RUNG DIFFERENCE. A claim is
 * `confirmed` exactly when the top rung selects it and `all` does not —
 * that difference IS the `human_confirmed` exclusion, by the classifier's
 * own definition. So the sub-count can be corrected without the bar
 * carrying a status it has no other use for.
 *
 * WHY „excludedOpen" USES THE TOP RUNG RATHER THAN THIS ONE. The server
 * classifies `open_in_workbench` BEFORE the rung filters, deliberately, so
 * a confirmed claim the reviewer has open reads as „gerade geöffnet"
 * instead of vanishing into a rung-definitional count. Membership of the
 * top rung is exactly „eligible and not discarded and not legacy", which is
 * the same condition, so this reproduces the server's grouping on every
 * rung instead of only on the one that happens to select the claim.
 */
export function buildRungView(
  preview: RecheckPreview,
  scope: RecheckScope,
  selectedClaimId: string | null,
  selectedClaimIsQueued: boolean,
): RecheckRungView {
  const rung: RecheckRungPreview = preview[scope];
  const inRung =
    selectedClaimId !== null && rung.claimIds.includes(selectedClaimId);
  const reportedAsOpen =
    selectedClaimId !== null &&
    preview.all_including_confirmed.claimIds.includes(selectedClaimId);
  const selectedIsConfirmed =
    reportedAsOpen && !preview.all.claimIds.includes(selectedClaimId);
  return {
    total: rung.total - (inRung ? 1 : 0),
    queued: rung.queued - (inRung && selectedClaimIsQueued ? 1 : 0),
    confirmed: rung.confirmed - (inRung && selectedIsConfirmed ? 1 : 0),
    excludedOpen: rung.exclusions.open_in_workbench + (reportedAsOpen ? 1 : 0),
    excludedDiscarded: rung.exclusions.discarded,
    excludedLegacy: rung.exclusions.legacy_unrouted,
  };
}

/**
 * The number the forcing step asks for: the QUEUED count, because that is
 * the thing at risk — claims a human still has to rule on.
 *
 * Degenerate case: when nothing is queued, asking the reviewer to type „0"
 * is friction without cognition, so the field asks for the total instead
 * (and the label below switches with it). When nothing is queued, the total
 * IS the thing at risk.
 */
export function forcingTarget(view: RecheckRungView): number {
  return view.queued > 0 ? view.queued : view.total;
}

/**
 * Whether what the reviewer typed is the number asked for.
 *
 * Compared as a base-ten integer after trimming, never as a raw string: a
 * string compare would reject „ 3" and „03", both of which demonstrate that
 * the reviewer read the number, and the forcing step exists to detect
 * reading rather than typing.
 */
export function typedMatches(raw: string, target: number): boolean {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return false;
  }
  return Number.parseInt(trimmed, 10) === target;
}

/** The exclusions line, or null when nothing is excluded — the whole line
 * is omitted rather than rendered empty. */
export function exclusionsLine(view: RecheckRungView): string | null {
  const parts: string[] = [];
  if (view.excludedOpen > 0) {
    parts.push(SWEEP_COPY.exclusionOpen(view.excludedOpen));
  }
  if (view.excludedDiscarded > 0) {
    parts.push(SWEEP_COPY.exclusionDiscarded(view.excludedDiscarded));
  }
  if (view.excludedLegacy > 0) {
    parts.push(SWEEP_COPY.exclusionLegacy(view.excludedLegacy));
  }
  if (parts.length === 0) {
    return null;
  }
  return SWEEP_COPY.exclusionsPrefix + parts.join(", ");
}

/**
 * Section 3 — the itemisation. Counts and groups only: never a list of
 * claim ids. A forty-item list would push the forcing field below the fold
 * of `Modal`'s `max-h-[80vh]` scroll area and make the last thing the
 * reviewer sees a wall of ids.
 *
 * Exported so the SSR test can render it at every rung without driving the
 * radio group, which `renderToStaticMarkup` cannot do.
 */
export function RecheckSweepItemisation({
  view,
  scope,
}: {
  view: RecheckRungView;
  scope: RecheckScope;
}) {
  const exclusions = exclusionsLine(view);
  return (
    <dl className="text-xs">
      <dt className="font-medium text-slate-600">
        {SWEEP_COPY.itemisationHeading}
      </dt>
      <dd className="mt-1 text-slate-800">{SWEEP_COPY.total(view.total)}</dd>
      {view.queued > 0 ? (
        <dd className="text-slate-600">{SWEEP_COPY.queued(view.queued)}</dd>
      ) : null}
      {scope === "all_including_confirmed" && view.confirmed > 0 ? (
        <dd className="text-slate-600">
          {SWEEP_COPY.confirmed(view.confirmed)}
        </dd>
      ) : null}
      {exclusions !== null ? (
        <dd className="mt-1 text-slate-500">{exclusions}</dd>
      ) : null}
    </dl>
  );
}

const initialSweepState: SweepFormState = { error: null };

/**
 * The sweep confirmation.
 *
 * Mounting the component IS opening the dialog (`Modal`'s contract): focus
 * trap, ESC and backdrop dismissal come from the native `<dialog>` and are
 * not re-implemented here.
 */
export function RecheckSweepDialog({
  projectId,
  preview,
  selectedClaimId,
  selectedClaimIsQueued,
  onClose,
  onRequested,
}: {
  projectId: string;
  /** All three rungs in one payload, so changing a rung recomputes the
   * itemisation instantly and the displayed count cannot drift from the
   * count the submit acts on. */
  preview: RecheckPreview;
  /** RERUN-04: the claim the reviewer has expanded right now, excluded from
   * the sweep and named in the exclusions line. */
  selectedClaimId: string | null;
  /** Whether that claim awaits manual adjudication — the one thing the
   * preview payload cannot say about a claim it did not exclude, and the
   * forcing step asks for the queued count. */
  selectedClaimIsQueued: boolean;
  onClose: () => void;
  onRequested: (result: { moved: number; excluded: number }) => void;
}) {
  const [scope, setScope] = useState<RecheckScope>("stale");
  const [typed, setTyped] = useState("");
  const [state, formAction, pending] = useActionState(
    requestClaimRecheckSweepAction.bind(null, projectId),
    initialSweepState,
  );

  const view = buildRungView(
    preview,
    scope,
    selectedClaimId,
    selectedClaimIsQueued,
  );
  const target = forcingTarget(view);
  const matches = typedMatches(typed, target);
  const showMismatch = typed.trim() !== "" && !matches;
  const empty = view.total === 0;

  useEffect(() => {
    if (state.moved !== undefined) {
      onRequested({ moved: state.moved, excluded: state.excluded ?? 0 });
      onClose();
    }
    // The effect fires on the action's result, not on the callbacks —
    // re-running it because a parent re-created `onClose` would close a
    // dialog the reviewer had re-opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Modal title={SWEEP_COPY.title} onClose={onClose}>
      <form action={formAction} className="space-y-4">
        {selectedClaimId !== null ? (
          <input
            type="hidden"
            name="exclude_claim_id"
            value={selectedClaimId}
          />
        ) : null}

        <p className="text-sm text-slate-600">{SWEEP_COPY.intro}</p>

        <fieldset disabled={pending} className="space-y-2">
          <legend className="text-xs font-medium text-slate-600">
            {SWEEP_COPY.ladderLegend}
          </legend>
          {RECHECK_RUNGS.map((rung) => {
            const rungView = buildRungView(
              preview,
              rung.value,
              selectedClaimId,
              selectedClaimIsQueued,
            );
            return (
              <label key={rung.value} className="flex gap-2">
                <input
                  type="radio"
                  name="scope"
                  value={rung.value}
                  checked={scope === rung.value}
                  onChange={() => {
                    setScope(rung.value);
                    // The number asked for changes with the rung, so a value
                    // typed against the previous rung must not stay valid.
                    setTyped("");
                  }}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm text-slate-800">
                    {rung.label} ({rungView.total})
                  </span>
                  <span className="block text-xs text-slate-500">
                    {rung.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {empty ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-700">
              {SWEEP_COPY.emptyHeading}
            </p>
            <p className="text-xs text-slate-600">{SWEEP_COPY.emptyBody}</p>
          </div>
        ) : (
          <RecheckSweepItemisation view={view} scope={scope} />
        )}

        <div className="space-y-1 text-xs text-slate-600">
          <p className="font-medium text-slate-600">
            {SWEEP_COPY.consequencesHeading}
          </p>
          <p>{SWEEP_COPY.consequence1}</p>
          <p>{SWEEP_COPY.consequence2}</p>
          <p>{SWEEP_COPY.consequence3}</p>
          <p>{SWEEP_COPY.consequence4}</p>
        </div>

        {empty ? null : (
          <div className="space-y-1">
            <label
              htmlFor="queued_confirmation"
              className="block text-xs text-slate-700"
            >
              {view.queued > 0
                ? SWEEP_COPY.forcingLabelQueued
                : SWEEP_COPY.forcingLabelTotal}
            </label>
            <input
              id="queued_confirmation"
              name="queued_confirmation"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              disabled={pending}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              aria-describedby="queued_confirmation_hint"
              className={`${compactInputClass} w-20`}
            />
            {/* Slate, never red: a wrong number here is the mechanism
                working, not an error. It blocks nothing beyond the disabled
                submit. */}
            <p id="queued_confirmation_hint" className="text-xs text-slate-500">
              {showMismatch ? SWEEP_COPY.forcingMismatch : ""}
            </p>
          </div>
        )}

        <div className="flex items-center gap-2">
          {empty ? null : (
            <button
              type="submit"
              disabled={pending || !matches}
              className={primaryButtonClass}
            >
              {pending ? SWEEP_COPY.ctaPending : SWEEP_COPY.cta(view.total)}
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            className={`rounded px-2 py-1 text-sm text-slate-600 hover:text-slate-900 disabled:opacity-50 ${focusRingClass}`}
          >
            {SWEEP_COPY.cancel}
          </button>
        </div>

        <ErrorBanner message={state.error} />
      </form>
    </Modal>
  );
}
