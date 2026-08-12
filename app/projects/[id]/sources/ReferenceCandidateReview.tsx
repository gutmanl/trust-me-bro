"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import {
  ConnectionLostNotice,
  ErrorBanner,
  fileInputClass,
  inputClass,
  primaryButtonClass,
  RunProgressFeed,
} from "@/app/components/ui";
import { useRunFeed } from "@/app/lib/useRunFeed";
import { StartBlockedNotice, useStartGate } from "../RunStatusProvider";
import type { ReferenceCaptureOutcome, ReviewCandidate } from "@/lib/pipeline";
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

/** Completion controls a candidate row offers, per method (finding:
 * real-world references — every detected reference must be completable). */
function needsTitleInput(method: ReviewCandidate["method"]): boolean {
  return method === "url" || method === "unresolved";
}
function offersDocumentUrl(method: ReviewCandidate["method"]): boolean {
  return usesDerivedDocumentUrl(method) || method === "unresolved";
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
    case "run_pause_requested":
      return "Pause angefordert – die laufende Erfassung wird noch abgeschlossen …";
    case "run_paused":
      return "Lauf pausiert. Fortsetzen erfasst die nächste Quelle.";
    case "run_resumed":
      return "Lauf fortgesetzt.";
    case "run_cancel_requested":
      return "Abbruch angefordert – die laufende Erfassung wird noch abgeschlossen …";
    case "run_cancelled":
      return "Lauf abgebrochen – bereits erfasste Quellen bleiben erhalten.";
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
 * Candidate list of a reference scan as ONE uncontrolled multipart form: a
 * checkbox per row submits `select_<candidateId>` together with its own
 * `source_type_<id>` / `title_<id>` / `document_url_<id>` / `file_<id>`
 * inputs, parsed by parseCaptureSelections(). EVERY not-yet-captured
 * candidate is a row now — including `unresolved` ones, which the user
 * completes in place by uploading a PDF or pasting a document URL (finding:
 * real-world references dead-ended here before). A candidate the user checks
 * without providing what its method needs (a title, or — for unresolved — a
 * document) fails server-side with a German per-item message without aborting
 * its siblings; no input is `required`, since native constraint validation
 * would otherwise let one unchecked incomplete row block the whole form
 * (I1 fix). Already-captured candidates are listed separately, greyed, so
 * nothing about the scan result disappears from view.
 */
export function ReferenceCandidateReview({
  projectId,
  candidates,
  activeRun,
  lastOutcomes,
}: {
  projectId: string;
  candidates: ReviewCandidate[];
  /** A capture batch is already running on the server for this project
   * (derived from the runner, not durable state — capture keeps none). Makes
   * a reload re-attach to the live run instead of offering a submit button
   * that would 409 with "already a run". */
  activeRun: boolean;
  /** Per-candidate outcomes of the last capture run, server-derived from the
   * runner so the "why did this not import" reason is shown on each failed row
   * and cannot be raced away by a fast run or the post-run refresh. */
  lastOutcomes: ReferenceCaptureOutcome[];
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

  const watching = !stopped && (formState.started === true || activeRun);
  const { blockedBy } = useStartGate("reference_capture");

  const { lines, connectionLost } = useRunFeed({
    kind: "reference_capture",
    active: watching,
    describe: describeProgress,
    onDone: () => {
      setStopped(true);
      router.refresh();
    },
  });

  // Server-derived failures, keyed by candidate, for the persistent summary and
  // the per-row reason. Not shown while a run is live (the feed covers that).
  const errorByCandidate = new Map(
    lastOutcomes
      .filter((outcome) => outcome.status === "error")
      .map((outcome) => [
        outcome.candidateId,
        outcome.error ?? "unbekannter Fehler",
      ]),
  );
  const capturedCount = lastOutcomes.filter(
    (outcome) => outcome.status === "ok",
  ).length;

  const alreadyCaptured = candidates.filter((c) => c.alreadyCaptured);
  // Every not-yet-captured candidate is completable in the form now,
  // including `unresolved` ones: the user finishes those by uploading a PDF
  // or pasting a document URL (finding: real-world references). Nothing
  // dead-ends in a separate read-only list any more.
  const openRows = candidates.filter((c) => !c.alreadyCaptured);
  const defaultSelectedCount = openRows.filter((c) => c.selected).length;

  return (
    <div className="space-y-4">
      {/* Persistent, server-derived outcome of the last run: always shown once
          a run has finished, independent of the volatile live feed. */}
      {!watching && (capturedCount > 0 || errorByCandidate.size > 0) ? (
        <CaptureSummary
          ok={capturedCount}
          failed={errorByCandidate.size}
          reasons={[...new Set(errorByCandidate.values())]}
        />
      ) : null}

      <form action={formAction} className="space-y-3">
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {openRows.map((candidate) => (
            <CandidateRow
              key={candidate.candidate_id}
              candidate={candidate}
              error={errorByCandidate.get(candidate.candidate_id)}
            />
          ))}
        </ul>

        <ErrorBanner message={formState.error} />
        {watching && connectionLost ? <ConnectionLostNotice /> : null}
        {blockedBy && !watching ? (
          <StartBlockedNotice label={blockedBy} />
        ) : null}

        <button
          type="submit"
          disabled={
            pending || watching || openRows.length === 0 || blockedBy !== null
          }
          className={primaryButtonClass}
        >
          {pending || watching
            ? "Wird erfasst …"
            : `Ausgewählte erfassen (${defaultSelectedCount})`}
        </button>
      </form>

      {/* Pause/cancel now live in the shared status bar (RunStatusProvider),
          the single control surface for whatever run is active. */}
      {watching ? (
        <RunProgressFeed title="Fortschritt der Erfassung" lines={lines} />
      ) : null}

      {alreadyCaptured.length > 0 ? (
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
        </ul>
      ) : null}
    </div>
  );
}

/** Persistent, server-derived outcome of the last capture run: how many
 * sources were imported and, grouped by reason, why the rest were not — so a
 * partial import is explained rather than looking like a silent failure.
 * Per-candidate reasons also render on each failed row below. */
function CaptureSummary({
  ok,
  failed,
  reasons,
}: {
  ok: number;
  failed: number;
  reasons: string[];
}) {
  return (
    <div
      className={`rounded-md border px-3 py-2 text-sm ${
        failed > 0
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-green-200 bg-green-50 text-green-700"
      }`}
    >
      <p className="font-medium">
        {ok} Quelle(n) erfasst
        {failed > 0 ? `, ${failed} nicht übernommen` : ""}.
      </p>
      {failed > 0 ? (
        <p className="mt-1 text-xs">
          Nicht automatisch abrufbare Quellen (z. B. Landing-Page statt PDF,
          oder kein frei verfügbarer Volltext) unten je Zeile per PDF-Upload
          oder direkter Dokument-URL ergänzen.
        </p>
      ) : null}
      {reasons.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One candidate row of the review form: a checkbox plus the completion
 * controls its method needs. An `unresolved` row (no identifier, no
 * auto-derived document) is now completable here — a title, plus an uploaded
 * PDF or a document URL — instead of being a dead end. */
function CandidateRow({
  candidate,
  error,
}: {
  candidate: ReviewCandidate;
  /** Reason this candidate did not import on the last run, if any. */
  error?: string;
}) {
  const id = candidate.candidate_id;
  const isUnresolved = candidate.method === "unresolved";
  return (
    <li className="space-y-2 p-3">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          name={`select_${id}`}
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
      {error ? (
        <p className="ml-6 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
          Beim letzten Lauf nicht übernommen: {error}
        </p>
      ) : null}
      <div className="ml-6 grid gap-2 sm:grid-cols-2">
        <div>
          <label
            htmlFor={`source_type_${id}`}
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Quellentyp
          </label>
          <select
            id={`source_type_${id}`}
            name={`source_type_${id}`}
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
              htmlFor={`title_${id}`}
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Titel
            </label>
            <input
              id={`title_${id}`}
              name={`title_${id}`}
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
              htmlFor={`document_url_${id}`}
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Dokument-URL (optional)
            </label>
            <input
              id={`document_url_${id}`}
              name={`document_url_${id}`}
              type="url"
              placeholder="Direktlink zum Volltext (PDF)"
              defaultValue={candidate.document_url ?? ""}
              className={`${inputClass} font-mono`}
            />
            <p className="mt-1 text-xs text-slate-500">
              {isUnresolved
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
            htmlFor={`file_${id}`}
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            PDF hochladen (optional)
          </label>
          <input
            id={`file_${id}`}
            name={`file_${id}`}
            type="file"
            accept="application/pdf,.pdf"
            className={fileInputClass}
          />
          <p className="mt-1 text-xs text-slate-500">
            Für Quellen ohne frei verfügbaren Volltext (z. B. hinter einer
            Paywall): die hochgeladene Datei wird als Dokument eingefroren und
            hat Vorrang vor einer URL.
          </p>
        </div>
      </div>
    </li>
  );
}
