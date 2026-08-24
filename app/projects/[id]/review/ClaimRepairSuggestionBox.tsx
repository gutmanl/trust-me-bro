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
  const [editing, setEditing] = useState(false);
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
}: {
  projectId: string;
  claimId: string;
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
        Diese Aussage kann ohne Beanstandung repariert werden – der Prüfbefund
        liefert die Kritik.
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
