"use client";

import { useActionState, useState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import type { ClaimRepairSuggestionVM } from "@/lib/pipeline";
import type {
  ApplyRepairFormState,
  DecisionFormState,
  RepairSuggestionRequestState,
} from "./actions";
import {
  applyRepairAction,
  dismissClaimRepairSuggestionAction,
  requestClaimRepairSuggestionsAction,
} from "./actions";

const applyInitial: ApplyRepairFormState = { error: null };
const dismissInitial: DecisionFormState = { error: null };
const requestInitial: RepairSuggestionRequestState = { error: null };

const ORIGIN_LABELS: Record<ClaimRepairSuggestionVM["origin"], string> = {
  negative_precheck: "aus der automatischen Vorprüfung",
  existence_check_failed: "aus der fehlgeschlagenen Zitatprüfung",
};

/**
 * The verdict-driven repair suggestion on a claim card (indigo, following
 * the source auto-repair `SuggestionBox` idiom): the machine's proposal,
 * labelled machine-generated and unconfirmed (P-14), with accepting still a
 * deliberate human step — the editable form opens only on click, and
 * nothing is pre-filled into a field that commits without one.
 */
export function ClaimRepairSuggestionBox({
  projectId,
  claimId,
  suggestion,
}: {
  projectId: string;
  claimId: string;
  suggestion: ClaimRepairSuggestionVM;
}) {
  const [applyState, applyAction, applyPending] = useActionState(
    applyRepairAction.bind(null, projectId, claimId),
    applyInitial,
  );
  const [dismissState, dismissAction, dismissPending] = useActionState(
    dismissClaimRepairSuggestionAction.bind(null, projectId, claimId),
    dismissInitial,
  );
  const [refreshState, refreshAction, refreshPending] = useActionState(
    requestClaimRepairSuggestionsAction.bind(null, projectId, claimId),
    requestInitial,
  );
  const [editing, setEditing] = useState(false);
  const [applyBriefing, setApplyBriefing] = useState(true);
  const [text, setText] = useState(suggestion.suggestedText);
  const source =
    text === suggestion.suggestedText
      ? "vorschlag_uebernommen"
      : "vorschlag_angepasst";
  const pending = applyPending || dismissPending;
  return (
    <div className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
      <p className="font-medium">
        💡 Reparaturvorschlag – maschinell erzeugt{" "}
        {ORIGIN_LABELS[suggestion.origin]}, unbestätigt
      </p>
      <p className="mt-1 whitespace-pre-wrap">„{suggestion.suggestedText}“</p>
      <p className="mt-1 text-indigo-700">{suggestion.reasoning}</p>
      {suggestion.evidenceRepairs !== undefined ? (
        <div className="mt-1.5 space-y-1">
          <p className="font-medium">
            Korrigierte{" "}
            {suggestion.evidenceRepairs.length === 1
              ? "Zitatstelle"
              : "Zitatstellen"}
            :
          </p>
          {suggestion.evidenceRepairs.map((repair) => (
            <p key={repair.evidenceId} className="text-indigo-700">
              <span className="font-mono">[{repair.evidenceId}]</span> „
              {repair.correctedExcerpt}“
            </p>
          ))}
        </div>
      ) : null}
      {suggestion.briefingRepair !== undefined ? (
        <div className="mt-1.5 space-y-1">
          <p className="font-medium">Vorgeschlagene Briefing-Passage:</p>
          <p className="whitespace-pre-wrap text-indigo-700">
            {suggestion.briefingRepair}
          </p>
        </div>
      ) : null}
      {suggestion.scrutiny !== undefined ? (
        suggestion.scrutiny.calibrationResult === "licensed" ? (
          <p className="mt-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-emerald-900">
            KI-Gegenprüfung bestanden: Die korrigierte Fassung gilt nach den
            Prüfstufen 2/3 als vom Belegbestand getragen
            {suggestion.scrutiny.attempts > 1
              ? ` (${suggestion.scrutiny.attempts}. Entwurf)`
              : ""}
            .
          </p>
        ) : (
          <p className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-900">
            KI-Gegenprüfung: Das Urteil zur korrigierten Fassung bliebe
            voraussichtlich eingeschränkt – {suggestion.scrutiny.reasoning}
          </p>
        )
      ) : null}
      {suggestion.outdated ? (
        <form
          action={refreshAction}
          className="mt-1.5 rounded-md border border-indigo-200 bg-white/60 px-2 py-1.5"
        >
          <p className="text-indigo-700">
            Veralteter Vorschlag: mit einer älteren Vorlagenfassung (v
            {suggestion.promptVersion}) erzeugt. Ein neu erzeugter Vorschlag
            kann auch eine korrigierte Briefing-Passage enthalten und ersetzt
            diesen.
          </p>
          <button
            type="submit"
            disabled={
              refreshPending ||
              (refreshState.queued !== undefined && refreshState.queued > 0)
            }
            className="mt-1 rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
          >
            {refreshPending
              ? "Wird eingereiht …"
              : refreshState.queued !== undefined && refreshState.queued > 0
                ? "Vorschlag wird erzeugt …"
                : "Aktuellen Vorschlag erzeugen"}
          </button>
          <ErrorBanner message={refreshState.error} />
        </form>
      ) : null}
      {editing ? (
        <form action={applyAction} className="mt-2 space-y-1.5">
          <textarea
            name="new_text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            disabled={pending}
            className="w-full rounded-md border border-indigo-300 bg-white px-2 py-1.5 text-xs text-slate-900"
          />
          <input type="hidden" name="source" value={source} />
          <input
            type="hidden"
            name="proposed_text"
            value={suggestion.suggestedText}
          />
          {suggestion.evidenceRepairs !== undefined ? (
            <input
              type="hidden"
              name="excerpt_repairs"
              value={JSON.stringify(suggestion.evidenceRepairs)}
            />
          ) : null}
          {suggestion.briefingRepair !== undefined ? (
            <>
              <input
                type="hidden"
                name="briefing_repair"
                value={suggestion.briefingRepair}
              />
              <label className="flex items-start gap-1.5 text-indigo-900">
                <input
                  type="checkbox"
                  name="apply_briefing"
                  checked={applyBriefing}
                  onChange={(event) => setApplyBriefing(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Auch die Briefing-Passage ersetzen (wird als neue
                  Briefing-Fassung veröffentlicht)
                </span>
              </label>
            </>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
            >
              {applyPending
                ? "Wird übernommen …"
                : "Reparatur übernehmen – erneute Prüfung folgt"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setText(suggestion.suggestedText);
              }}
              className="px-1 py-1 text-xs font-medium text-indigo-800 underline decoration-indigo-300 hover:text-indigo-950 disabled:opacity-50"
            >
              Abbrechen
            </button>
          </div>
          <ErrorBanner message={applyState.error} />
          {applyState.briefingError !== undefined ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-900">
              Aussage repariert – die Briefing-Passage wurde jedoch NICHT
              ersetzt: {applyState.briefingError} Der Vorschlagstext oben bleibt
              für eine spätere manuelle Korrektur sichtbar.
            </p>
          ) : null}
        </form>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => setEditing(true)}
            className="rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
          >
            Übernehmen oder anpassen
          </button>
          <form action={dismissAction}>
            <button
              type="submit"
              disabled={pending}
              className="px-1 py-1 text-xs font-medium text-indigo-800 underline decoration-indigo-300 hover:text-indigo-950 disabled:opacity-50"
            >
              {dismissPending ? "Wird verworfen …" : "Verwerfen"}
            </button>
            <ErrorBanner message={dismissState.error} />
          </form>
        </div>
      )}
    </div>
  );
}

/**
 * The REPAIR-05 affordance on an eligible card that carries no suggestion
 * yet: states what unlocks a repair (the machine's own critique — no
 * complaint needed) and requests the generation. The suggestion arrives via
 * the chain trigger's terminal event and the stream's refresh.
 */
export function RequestClaimRepairSuggestion({
  projectId,
  claimId,
  capped = false,
}: {
  projectId: string;
  claimId: string;
  /** The verdict is mechanically capped (verdict-driven repair): the
   * automatic generation skips this claim, and the manual request carries
   * the warning that no wording can lift the verdict. */
  capped?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    requestClaimRepairSuggestionsAction.bind(null, projectId, claimId),
    requestInitial,
  );
  const queued = state.queued !== undefined && state.queued > 0;
  return (
    <form
      action={formAction}
      className="rounded-md border border-dashed border-indigo-200 px-3 py-2 text-xs"
    >
      <p className="text-slate-500">
        {capped
          ? "Das Urteil dieser Aussage ist mechanisch begrenzt (siehe " +
            "Vorprüfung) – ein Umformulierungsvorschlag kann es nicht " +
            "anheben, nur weitere Belege oder Ihre Entscheidung."
          : "Diese Aussage kann ohne Beanstandung repariert werden – der " +
            "Prüfbefund liefert die Kritik."}
      </p>
      <button
        type="submit"
        disabled={pending || queued}
        className="mt-1.5 rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
      >
        {pending
          ? "Wird eingereiht …"
          : queued
            ? "Vorschlag wird erzeugt …"
            : "Reparaturvorschlag anfordern"}
      </button>
      <ErrorBanner message={state.error} />
    </form>
  );
}
