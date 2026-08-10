"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import {
  ErrorBanner,
  inputClass,
  primaryButtonClass,
  RunProgressFeed,
} from "@/app/components/ui";
import { useJobStream } from "@/app/lib/useJobStream";
import type { ReviewCandidate } from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";
import type { ReferenceCaptureFormState } from "./reference-scan-actions";
import { startReferenceCaptureAction } from "./reference-scan-actions";

const initialState: ReferenceCaptureFormState = { error: null };

const SOURCE_TYPE_OPTIONS: { value: SourceType; label: string }[] = [
  { value: "peer_reviewed_publication", label: "Begutachtete Publikation" },
  { value: "preprint", label: "Preprint" },
  { value: "grey_literature", label: "Grauliteratur" },
  { value: "vendor_documentation", label: "Herstellerdokumentation" },
];

const METHOD_LABELS: Record<ReviewCandidate["method"], string> = {
  doi: "DOI",
  arxiv: "arXiv",
  url: "URL",
  crossref_title: "Crossref (Titelabgleich)",
  unresolved: "nicht aufgelöst",
};

/** Candidates whose document-url is derived from an identifier, not from
 * the candidate's own url — the ones the review form offers an override
 * input for (Amendment 1 item 6; a `url`-method candidate's own url already
 * IS the document to capture). */
function usesDerivedDocumentUrl(method: ReviewCandidate["method"]): boolean {
  return method === "doi" || method === "arxiv" || method === "crossref_title";
}

function describeProgress(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "run_started":
      return "Erfassung gestartet.";
    case "item_completed": {
      const outcome = event.outcome as
        | { status: string; result?: { message?: string }; error?: string }
        | undefined;
      if (outcome?.status === "ok") {
        return outcome.result?.message ?? "Quelle erfasst.";
      }
      return `Fehlgeschlagen: ${outcome?.error ?? "unbekannt"}`;
    }
    case "run_completed":
      return "Lauf beendet.";
    default:
      return null;
  }
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
        {METHOD_LABELS[candidate.method]}
      </span>
      {candidate.match_score !== undefined ? (
        <span>Übereinstimmung: {Math.round(candidate.match_score * 100)}%</span>
      ) : null}
      {bits.length > 0 ? <span>{bits.join(" · ")}</span> : null}
    </div>
  );
}

/**
 * Candidate list of a reference scan as ONE uncontrolled form: a checkbox
 * per selectable row submits `select_<candidateId>` together with its own
 * `source_type_<id>` / `title_<id>` / `document_url_<id>` inputs, parsed by
 * parseCaptureSelections(). Already-captured and not-(yet)-capturable rows
 * are always shown, never hidden — greyed/informational, with the reason —
 * so nothing about the scan result disappears from view.
 */
export function ReferenceCandidateReview({
  projectId,
  candidates,
}: {
  projectId: string;
  candidates: ReviewCandidate[];
}) {
  const router = useRouter();
  const [formState, formAction, pending] = useActionState(
    startReferenceCaptureAction.bind(null, projectId),
    initialState,
  );
  const [startedForm, setStartedForm] =
    useState<ReferenceCaptureFormState | null>(null);
  const [stopped, setStopped] = useState(false);

  if (formState.started && startedForm !== formState) {
    setStartedForm(formState);
    setStopped(false);
  }

  const watching = !stopped && formState.started === true;

  const { lines } = useJobStream({
    streamUrl: `/api/projects/${projectId}/reference-capture/stream`,
    active: watching,
    describe: describeProgress,
    onDone: () => {
      setStopped(true);
      router.refresh();
    },
  });

  const alreadyCaptured = candidates.filter((c) => c.alreadyCaptured);
  const selectableRows = candidates.filter(
    (c) => !c.alreadyCaptured && c.capturable,
  );
  const notCapturable = candidates.filter(
    (c) => !c.alreadyCaptured && !c.capturable && c.method !== "unresolved",
  );
  const unresolved = candidates.filter(
    (c) => !c.alreadyCaptured && c.method === "unresolved",
  );
  const defaultSelectedCount = selectableRows.filter((c) => c.selected).length;

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-3">
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {selectableRows.map((candidate) => (
            <li key={candidate.candidate_id} className="space-y-2 p-3">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  name={`select_${candidate.candidate_id}`}
                  defaultChecked={candidate.selected}
                  className="mt-1"
                />
                <span>
                  <span className="text-sm font-medium text-slate-800">
                    {candidate.title ?? candidate.raw_text}
                  </span>
                  <CandidateMeta candidate={candidate} />
                </span>
              </label>
              <div className="ml-6 grid gap-2 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor={`source_type_${candidate.candidate_id}`}
                    className="mb-1 block text-xs font-medium text-slate-600"
                  >
                    Quellentyp
                  </label>
                  <select
                    id={`source_type_${candidate.candidate_id}`}
                    name={`source_type_${candidate.candidate_id}`}
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
                {candidate.method === "url" ? (
                  <div>
                    <label
                      htmlFor={`title_${candidate.candidate_id}`}
                      className="mb-1 block text-xs font-medium text-slate-600"
                    >
                      Titel
                    </label>
                    <input
                      id={`title_${candidate.candidate_id}`}
                      name={`title_${candidate.candidate_id}`}
                      required
                      defaultValue={candidate.title ?? ""}
                      className={inputClass}
                    />
                  </div>
                ) : null}
                {usesDerivedDocumentUrl(candidate.method) ? (
                  <div className="sm:col-span-2">
                    <label
                      htmlFor={`document_url_${candidate.candidate_id}`}
                      className="mb-1 block text-xs font-medium text-slate-600"
                    >
                      Dokument-URL (optional)
                    </label>
                    <input
                      id={`document_url_${candidate.candidate_id}`}
                      name={`document_url_${candidate.candidate_id}`}
                      type="url"
                      placeholder="Direktlink zum Volltext (PDF)"
                      defaultValue={candidate.document_url ?? ""}
                      className={`${inputClass} font-mono`}
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      {candidate.document_url
                        ? "Automatisch ermittelt – bei Bedarf überschreiben."
                        : "Keine Dokument-URL automatisch ermittelt – DOI-Quellen benötigen eine, sonst schlägt die Übernahme fehl."}
                    </p>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        <ErrorBanner message={formState.error} />

        <button
          type="submit"
          disabled={pending || watching || selectableRows.length === 0}
          className={primaryButtonClass}
        >
          {pending || watching
            ? "Wird erfasst …"
            : `Ausgewählte erfassen (${defaultSelectedCount})`}
        </button>

        {watching ? (
          <RunProgressFeed title="Fortschritt der Erfassung" lines={lines} />
        ) : null}
      </form>

      {alreadyCaptured.length > 0 || notCapturable.length > 0 ? (
        <ul className="space-y-1 text-sm text-slate-500">
          {alreadyCaptured.map((candidate) => (
            <li
              key={candidate.candidate_id}
              className="rounded-md bg-slate-50 px-3 py-2 opacity-70"
            >
              {candidate.title ?? candidate.raw_text} – bereits erfasst als{" "}
              <span className="font-mono">{candidate.capturedAsSourceId}</span>.
            </li>
          ))}
          {notCapturable.map((candidate) => (
            <li
              key={candidate.candidate_id}
              className="rounded-md bg-slate-50 px-3 py-2 opacity-70"
            >
              {candidate.raw_text} – kein Titel ermittelt, kann nicht
              automatisch übernommen werden. Bitte manuell erfassen.
            </li>
          ))}
        </ul>
      ) : null}

      {unresolved.length > 0 ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs font-medium text-slate-600">
            Nicht automatisch übernehmbar
          </p>
          <ul className="space-y-1 text-sm text-slate-500">
            {unresolved.map((candidate) => (
              <li key={candidate.candidate_id}>
                {candidate.raw_text} – kann nicht automatisch übernommen werden
                – bitte manuell erfassen.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
