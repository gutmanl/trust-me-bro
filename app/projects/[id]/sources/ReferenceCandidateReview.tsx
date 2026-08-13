"use client";

import { useActionState, useState } from "react";

import {
  ErrorBanner,
  fileInputClass,
  inputClass,
  primaryButtonClass,
} from "@/app/components/ui";
import type { ReviewCandidate, SourceWorkItemVM } from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";
import { formatTimestamp, SOURCE_TYPE_LABELS } from "../../status-labels";
import {
  CapturingChip,
  DismissButton,
  FailureBox,
  QueuedChip,
} from "../workbench/WorkItemRow";
import type {
  CandidateCaptureFormState,
  ReadyCandidatesFormState,
} from "./reference-scan-actions";
import {
  captureCandidateAction,
  captureReadyCandidatesAction,
} from "./reference-scan-actions";

const initialState: CandidateCaptureFormState = { error: null };

/** Derived from the one house label map — the dropdown can never drift
 * from how the rest of the app names a source type. */
const SOURCE_TYPE_OPTIONS = (
  Object.entries(SOURCE_TYPE_LABELS) as [SourceType, string][]
).map(([value, label]) => ({ value, label }));

const METHOD_LABELS: Record<ReviewCandidate["method"], string> = {
  doi: "DOI",
  arxiv: "arXiv",
  url: "URL",
  crossref_title: "Crossref (Titelabgleich)",
  unresolved: "nicht aufgelöst",
};

/** Candidates whose document-url is derived from an identifier, not from
 * the candidate's own url — the ones the completion form offers an override
 * input for (Amendment 1 item 6; a `url`-method candidate's own url already
 * IS the document to capture). */
function usesDerivedDocumentUrl(method: ReviewCandidate["method"]): boolean {
  return method === "doi" || method === "arxiv" || method === "crossref_title";
}

/** Completion controls a candidate row offers, per method (finding:
 * real-world references — every detected reference must be completable). */
function needsTitleInput(method: ReviewCandidate["method"]): boolean {
  return method === "url" || method === "unresolved";
}
function offersDocumentUrl(method: ReviewCandidate["method"]): boolean {
  return usesDerivedDocumentUrl(method) || method === "unresolved";
}

function CandidateMeta({ candidate }: { candidate: ReviewCandidate }) {
  const bits: string[] = [];
  if (candidate.authors && candidate.authors.length > 0) {
    bits.push(candidate.authors.join(", "));
  }
  if (candidate.year !== undefined) {
    bits.push(String(candidate.year));
  }
  if (candidate.venue) {
    bits.push(candidate.venue);
  }
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
      <span className="rounded-full bg-slate-100 px-2 py-0.5">
        Kandidat · {METHOD_LABELS[candidate.method]}
      </span>
      {candidate.match_score !== undefined ? (
        <span>Übereinstimmung: {Math.round(candidate.match_score * 100)}%</span>
      ) : null}
      {bits.length > 0 ? <span>{bits.join(" · ")}</span> : null}
    </div>
  );
}

/**
 * One open reference candidate as a row of the unified sources list (source
 * work items): its own form, its own "Übernehmen", its completion inputs
 * behind a disclosure — the batch checkbox form is gone. Queue state and
 * durable failures arrive via the candidate's work item (same id), so a
 * failed attempt renders its reason right on the row, surviving restarts.
 */
export function CandidateRow({
  projectId,
  candidate,
  workItem,
  liveCapturing,
}: {
  projectId: string;
  candidate: ReviewCandidate;
  /** The candidate's capture work item, when one is queued/running/failed. */
  workItem?: SourceWorkItemVM;
  liveCapturing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [formState, formAction, pending] = useActionState(
    captureCandidateAction.bind(null, projectId, candidate.candidate_id),
    initialState,
  );

  const capturing = liveCapturing || workItem?.status === "capturing";
  const queued = !capturing && workItem?.status === "queued";
  const failure =
    !capturing && workItem?.status === "failed" ? workItem : undefined;
  const busy = capturing || queued;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-slate-800">
          {candidate.title ?? candidate.raw_text}
        </p>
        {capturing ? <CapturingChip /> : queued ? <QueuedChip /> : null}
      </div>
      <CandidateMeta candidate={candidate} />

      {failure !== undefined ? (
        <FailureBox>
          <p>
            ⚠ Beim letzten Versuch nicht übernommen: {failure.error}
            {failure.failedAt !== undefined ? (
              <span className="text-amber-700">
                {" "}
                ({formatTimestamp(failure.failedAt)})
              </span>
            ) : null}
          </p>
          <div className="mt-1 flex">
            <DismissButton
              projectId={projectId}
              workItemId={failure.workItemId}
            />
          </div>
        </FailureBox>
      ) : null}

      {busy ? null : !open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2 text-xs font-medium text-slate-500 underline decoration-slate-300 hover:text-slate-700"
        >
          {candidate.capturable ? "Übernehmen …" : "Vervollständigen …"}
        </button>
      ) : (
        <form
          action={formAction}
          className="mt-3 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label
                htmlFor={`source_type_${candidate.candidate_id}`}
                className="mb-1 block text-xs font-medium text-slate-600"
              >
                Quellentyp
              </label>
              <select
                id={`source_type_${candidate.candidate_id}`}
                name="source_type"
                defaultValue={candidate.suggested_source_type}
                className={inputClass}
              >
                {SOURCE_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {needsTitleInput(candidate.method) ? (
              <div>
                <label
                  htmlFor={`title_${candidate.candidate_id}`}
                  className="mb-1 block text-xs font-medium text-slate-600"
                >
                  Titel
                </label>
                <input
                  id={`title_${candidate.candidate_id}`}
                  name="title"
                  defaultValue={candidate.title ?? ""}
                  className={inputClass}
                />
                {!candidate.title ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Kein Titel ermittelt – bitte eintragen, sonst schlägt die
                    Übernahme fehl.
                  </p>
                ) : null}
              </div>
            ) : null}

            {offersDocumentUrl(candidate.method) ? (
              <div className="sm:col-span-2">
                <label
                  htmlFor={`document_url_${candidate.candidate_id}`}
                  className="mb-1 block text-xs font-medium text-slate-600"
                >
                  Dokument-URL (optional)
                </label>
                <input
                  id={`document_url_${candidate.candidate_id}`}
                  name="document_url"
                  type="url"
                  placeholder="Direktlink zum Volltext (PDF)"
                  defaultValue={candidate.document_url ?? ""}
                  className={`${inputClass} font-mono`}
                />
                <p className="mt-1 text-xs text-slate-500">
                  {candidate.method === "unresolved"
                    ? candidate.crossref_unavailable
                      ? "Crossref war bei diesem Scan nicht erreichbar – ein erneuter Scan könnte die Quelle auflösen. Ansonsten hier eine Dokument-URL angeben oder unten ein PDF hochladen."
                      : "Automatisch nicht aufgelöst – hier eine Dokument-URL (PDF) angeben oder unten ein PDF hochladen."
                    : candidate.document_url
                      ? "Automatisch ermittelt – bei Bedarf überschreiben."
                      : "Keine Dokument-URL automatisch ermittelt – hier eintragen oder unten ein PDF hochladen."}{" "}
                  Bei einer manuell eingetragenen URL entfällt die automatische
                  Prüfung, ob das Dokument tatsächlich ein PDF ist.
                </p>
              </div>
            ) : null}

            <div className="sm:col-span-2">
              <label
                htmlFor={`file_${candidate.candidate_id}`}
                className="mb-1 block text-xs font-medium text-slate-600"
              >
                PDF hochladen (optional)
              </label>
              <input
                id={`file_${candidate.candidate_id}`}
                name="file"
                type="file"
                accept="application/pdf,.pdf"
                className={fileInputClass}
              />
              <p className="mt-1 text-xs text-slate-500">
                Für Quellen ohne frei verfügbaren Volltext (z. B. hinter einer
                Paywall): die hochgeladene Datei wird als Dokument eingefroren
                und hat Vorrang vor einer URL.
              </p>
            </div>
          </div>

          <ErrorBanner message={formState.error} />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending}
              className={primaryButtonClass}
            >
              {pending ? "Wird eingereiht …" : "Übernehmen"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
            >
              Abbrechen
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

const readyInitial: ReadyCandidatesFormState = { error: null };

/** "Alle offenen übernehmen": queues every candidate the review would
 * submit unmodified — one work item each, individually retryable. */
export function CaptureReadyCandidatesButton({
  projectId,
  count,
}: {
  projectId: string;
  count: number;
}) {
  const [state, formAction, pending] = useActionState(
    captureReadyCandidatesAction.bind(null, projectId),
    readyInitial,
  );
  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
      >
        {pending ? "Wird eingereiht …" : `Alle offenen übernehmen (${count})`}
      </button>
      <ErrorBanner message={state.error} />
    </form>
  );
}
