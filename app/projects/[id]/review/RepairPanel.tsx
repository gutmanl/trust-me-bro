"use client";

import { useActionState, useState } from "react";

import {
  ErrorBanner,
  primaryButtonClass,
  SuccessBanner,
} from "@/app/components/ui";
import type { Claim } from "@/lib/pipeline";
import type {
  AnchorRepairFormState,
  ApplyRepairFormState,
  DecisionFormState,
  RepairProposalFormState,
} from "./actions";
import {
  applyRepairAction,
  discardClaimAction,
  proposeRepairAction,
  repairBriefingPassageAction,
  repairClaimAnchorAction,
} from "./actions";

const proposalInitial: RepairProposalFormState = { error: null };
const applyInitial: ApplyRepairFormState = { error: null };
const discardInitial: DecisionFormState = { error: null };
const anchorInitial: AnchorRepairFormState = { error: null };

/** One briefing paragraph as the anchor picker offers it. */
export interface ParagraphOption {
  /** 0-based paragraph index; the `p<N>` anchor is index + 1. */
  index: number;
  text: string;
}

/** Whitespace/case-insensitive containment, the UI-side echo of the
 * pipeline's `containsNormalized`. Used only to PRESELECT the paragraph a
 * claim's quote currently lives in — the binding check runs server-side in
 * `repairClaimAnchor`, which refuses an anchor whose paragraph does not
 * contain the quote. */
function looselyContains(haystack: string, needle: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedNeedle = normalize(needle);
  return (
    normalizedNeedle.length > 0 &&
    normalize(haystack).includes(normalizedNeedle)
  );
}

function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 90 ? `${collapsed.slice(0, 90)}…` : collapsed;
}

/**
 * Repair, in the three ways a claim can be wrong (TMB-37 + workbench epic):
 *
 * 1. the WORDING overstates its evidence → an evidence-backed reformulation
 *    (proposed by the adapter, accepted or adjusted by the reviewer) that
 *    re-enters only the affected stages,
 * 2. the ANCHOR points at the wrong paragraph → „Anker korrigieren",
 * 3. the PASSAGE itself is wrong → „Briefing-Passage korrigieren", which
 *    publishes a briefing revision.
 *
 * Only the first is a claim-status operation and it is therefore offered
 * only for contested claims; the two anchor repairs apply in any status,
 * because an anchor is just as wrong on a confirmed claim as on a contested
 * one. Repeatedly failing wording repairs escalate instead of iterating
 * endlessly.
 */
export function RepairPanel({
  projectId,
  claim,
  paragraphs,
  anchoredParagraph,
}: {
  projectId: string;
  claim: Claim;
  /** The briefing's paragraphs, for the anchor picker. Absent (empty) only
   * where no briefing view is available. */
  paragraphs?: ParagraphOption[];
  /** The paragraph the claim currently resolves to, seeding the passage
   * editor. Absent for an unanchored claim — which is exactly the case
   * „Anker korrigieren" exists for. */
  anchoredParagraph?: ParagraphOption;
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

  const textRepairAvailable = claim.status === "contested";
  const pending = proposePending || applyPending || discardPending;
  const source =
    suggestion === undefined
      ? "manuell"
      : text === suggestion.suggested_text
        ? "vorschlag_uebernommen"
        : "vorschlag_angepasst";

  return (
    <div className="space-y-3 border-t border-slate-200 pt-4">
      <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
        Reparatur
      </h3>

      {textRepairAvailable ? (
        <>
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
              {suggestion
                ? "(Vorschlag anpassbar)"
                : "(oder manuell formulieren)"}
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
        </>
      ) : null}

      <AnchorRepairForms
        projectId={projectId}
        claim={claim}
        paragraphs={paragraphs ?? []}
        anchoredParagraph={anchoredParagraph}
      />

      {textRepairAvailable ? (
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
              Aussage verwerfen (bleibt mit Begründung im Register sichtbar)
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The two anchor repairs, each behind its own disclosure so the panel does
 * not open with three editors at once. */
function AnchorRepairForms({
  projectId,
  claim,
  paragraphs,
  anchoredParagraph,
}: {
  projectId: string;
  claim: Claim;
  paragraphs: ParagraphOption[];
  anchoredParagraph?: ParagraphOption;
}) {
  const [anchorState, anchorAction, anchorPending] = useActionState(
    repairClaimAnchorAction.bind(null, projectId, claim.id),
    anchorInitial,
  );
  const [passageState, passageAction, passagePending] = useActionState(
    repairBriefingPassageAction.bind(null, projectId, claim.id),
    anchorInitial,
  );
  const [open, setOpen] = useState<"none" | "anchor" | "passage">("none");

  const quote = claim.anchor_quote ?? "";
  // Prefill the picker with the paragraph the quote is actually in — the
  // whole point of the correction is usually that it is NOT the one the
  // claim currently names.
  const suggested =
    paragraphs.find((paragraph) => looselyContains(paragraph.text, quote)) ??
    anchoredParagraph ??
    paragraphs[0];

  if (paragraphs.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      {open === "none" ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setOpen("anchor")}
            className="text-xs font-medium text-slate-600 underline decoration-slate-300 hover:text-slate-800"
          >
            Anker korrigieren
          </button>
          {anchoredParagraph !== undefined ? (
            <button
              type="button"
              onClick={() => setOpen("passage")}
              className="text-xs font-medium text-slate-600 underline decoration-slate-300 hover:text-slate-800"
            >
              Briefing-Passage korrigieren
            </button>
          ) : null}
        </div>
      ) : null}

      {open === "anchor" ? (
        <form action={anchorAction} className="space-y-2">
          <p className="text-xs font-medium text-slate-600">
            Anker korrigieren
          </p>
          <p className="text-xs text-slate-500">
            Absatz wählen, in dem der zitierte Wortlaut steht. Die Korrektur
            wird als Ereignis in der Historie festgehalten.
          </p>
          <label htmlFor={`anchor-select-${claim.id}`} className="sr-only">
            Absatz
          </label>
          <select
            id={`anchor-select-${claim.id}`}
            name="anchor"
            defaultValue={suggested ? `p${suggested.index + 1}` : ""}
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-slate-500 focus:outline-none"
          >
            {paragraphs.map((paragraph) => (
              <option key={paragraph.index} value={`p${paragraph.index + 1}`}>
                p{paragraph.index + 1} · {preview(paragraph.text)}
              </option>
            ))}
          </select>
          <label
            htmlFor={`anchor-quote-${claim.id}`}
            className="block text-xs font-medium text-slate-600"
          >
            Zitierter Wortlaut
          </label>
          <textarea
            id={`anchor-quote-${claim.id}`}
            name="quote"
            rows={2}
            defaultValue={quote}
            required
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-slate-500 focus:outline-none"
          />
          <ErrorBanner message={anchorState.error} />
          {anchorState.repaired === true ? (
            <SuccessBanner>
              Anker korrigiert – die Änderung steht als Ereignis in der
              Historie.
            </SuccessBanner>
          ) : null}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={anchorPending}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              {anchorPending ? "Wird korrigiert …" : "Anker speichern"}
            </button>
            <button
              type="button"
              onClick={() => setOpen("none")}
              className="px-2 py-1.5 text-xs text-slate-500 hover:text-slate-700"
            >
              Abbrechen
            </button>
          </div>
        </form>
      ) : null}

      {open === "passage" && anchoredParagraph !== undefined ? (
        <form action={passageAction} className="space-y-2">
          <p className="text-xs font-medium text-slate-600">
            Briefing-Passage korrigieren
          </p>
          <p className="text-xs text-slate-500">
            Ersetzt Absatz p{anchoredParagraph.index + 1} des Briefings und
            veröffentlicht das Ergebnis als neue Revision.
          </p>
          <label htmlFor={`passage-${claim.id}`} className="sr-only">
            Korrigierte Passage
          </label>
          <textarea
            id={`passage-${claim.id}`}
            name="passage"
            rows={5}
            defaultValue={anchoredParagraph.text}
            required
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-slate-500 focus:outline-none"
          />
          <ErrorBanner message={passageState.error} />
          {passageState.repaired === true ? (
            <SuccessBanner>
              Passage korrigiert – als neue Briefing-Revision veröffentlicht.
            </SuccessBanner>
          ) : null}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={passagePending}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              {passagePending ? "Wird veröffentlicht …" : "Passage speichern"}
            </button>
            <button
              type="button"
              onClick={() => setOpen("none")}
              className="px-2 py-1.5 text-xs text-slate-500 hover:text-slate-700"
            >
              Abbrechen
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
