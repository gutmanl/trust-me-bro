"use client";

import { useActionState, useState } from "react";

import { ErrorBanner, primaryButtonClass } from "@/app/components/ui";
import type { Claim } from "@/lib/pipeline";
import type {
  ApplyRepairFormState,
  DecisionFormState,
  RepairProposalFormState,
} from "./actions";
import {
  applyRepairAction,
  discardClaimAction,
  proposeRepairAction,
} from "./actions";

const proposalInitial: RepairProposalFormState = { error: null };
const applyInitial: ApplyRepairFormState = { error: null };
const discardInitial: DecisionFormState = { error: null };

/**
 * The repair step for beanstandet claims (TMB-37): the adapter proposes an
 * evidence-backed reformulation, the reviewer accepts, adjusts or discards.
 * The accepted wording re-enters only the affected stages (mechanical rule
 * in the pipeline); repeatedly failing repairs escalate instead of
 * iterating endlessly.
 */
export function RepairPanel({
  projectId,
  claim,
}: {
  projectId: string;
  claim: Claim;
}) {
  const [proposalState, proposeAction, proposePending] = useActionState(
    proposeRepairAction.bind(null, projectId, claim.id),
    proposalInitial,
  );
  const [applyState, applyAction, applyPending] = useActionState(
    applyRepairAction.bind(null, projectId, claim.id),
    applyInitial,
  );
  const [discardState, discardAction, discardPending] = useActionState(
    discardClaimAction.bind(null, projectId, claim.id),
    discardInitial,
  );
  const [text, setText] = useState("");
  const [seenSuggestion, setSeenSuggestion] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);

  // Render-phase adjustment: a fresh proposal pre-fills the editable text.
  const suggestion = proposalState.suggestion;
  if (suggestion && seenSuggestion !== suggestion.suggested_text) {
    setSeenSuggestion(suggestion.suggested_text);
    setText(suggestion.suggested_text);
  }

  const pending = proposePending || applyPending || discardPending;
  const source =
    suggestion === undefined
      ? "manuell"
      : text === suggestion.suggested_text
        ? "vorschlag_uebernommen"
        : "vorschlag_angepasst";

  return (
    <div className="space-y-3 border-t border-slate-200 pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Reparatur
      </h3>

      <form action={proposeAction}>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {proposePending
            ? "Backend formuliert Vorschlag … (kann Minuten dauern)"
            : "Reparaturvorschlag generieren"}
        </button>
      </form>
      <ErrorBanner message={proposalState.error} />

      {suggestion ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <p className="font-semibold text-slate-500">
            Begründung des Vorschlags
          </p>
          <p className="mt-1">{suggestion.reasoning}</p>
        </div>
      ) : null}

      <form action={applyAction} className="space-y-2">
        <label
          htmlFor={`repair-text-${claim.id}`}
          className="text-xs font-medium text-slate-600"
        >
          Überarbeitete Fassung{" "}
          {suggestion ? "(Vorschlag anpassbar)" : "(oder manuell formulieren)"}
        </label>
        <textarea
          id={`repair-text-${claim.id}`}
          name="new_text"
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <input type="hidden" name="source" value={source} readOnly />
        <input
          type="hidden"
          name="proposed_text"
          value={suggestion?.suggested_text ?? ""}
          readOnly
        />
        <ErrorBanner message={applyState.error} />
        <button
          type="submit"
          disabled={pending || text.trim().length === 0}
          className={primaryButtonClass}
        >
          {applyPending
            ? "Wird übernommen …"
            : "Übernehmen und erneut prüfen"}
        </button>
      </form>

      <div className="border-t border-slate-100 pt-3">
        {discardOpen ? (
          <form action={discardAction} className="space-y-2">
            <label
              htmlFor={`discard-reason-${claim.id}`}
              className="text-xs font-medium text-slate-600"
            >
              Begründung für das Verwerfen
            </label>
            <input
              id={`discard-reason-${claim.id}`}
              name="reason"
              required
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
            <ErrorBanner message={discardState.error} />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={pending}
                className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {discardPending ? "Wird verworfen …" : "Endgültig verwerfen"}
              </button>
              <button
                type="button"
                onClick={() => setDiscardOpen(false)}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100"
              >
                Abbrechen
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setDiscardOpen(true)}
            className="text-xs text-red-700 underline decoration-red-300 hover:decoration-red-600"
          >
            Claim verwerfen (bleibt mit Begründung im Register sichtbar)
          </button>
        )}
      </div>
    </div>
  );
}
