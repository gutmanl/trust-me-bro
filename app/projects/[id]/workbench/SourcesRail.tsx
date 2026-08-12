"use client";

import { useActionState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import { useProjectEvents } from "@/app/lib/ProjectEventStream";
import type {
  ExtractionActivity,
  ReferenceCaptureOutcome,
  ReferenceScanState,
  ReviewCandidate,
  UnpaywallSetting,
} from "@/lib/pipeline";
import { StartBlockedNotice, useStartGate } from "../RunStatusProvider";
import { ReferenceCandidateReview } from "../sources/ReferenceCandidateReview";
import { ReferenceScanPanel } from "../sources/ReferenceScanPanel";
import { CaptureSourceForm } from "../sources/SourceForms";
import { UnpaywallSettingPanel } from "../sources/UnpaywallSettingPanel";
import type { RunFormState } from "./actions";
import { startUnevidencedExtractionAction } from "./actions";
import { SourceRow, type SourceRowVM } from "./SourceRow";

/** Everything the reference auto-import section needs; null before a
 * briefing exists, because there is nothing to scan for references in. */
export interface ReferenceImportVM {
  scanState: ReferenceScanState;
  unpaywall: UnpaywallSetting;
  candidates: ReviewCandidate[];
  captureRunActive: boolean;
  captureOutcomes: ReferenceCaptureOutcome[];
  llmAvailable: boolean;
  lastScanMethod?: "regex" | "regex+llm";
}

const sweepInitial: RunFormState = { error: null };

/**
 * The workbench's source column: the captured sources with their lifecycle,
 * the ways to add more (by hand, or from the references the briefing itself
 * cites), and the sweep for claims that cite nothing at all.
 *
 * The "pending" chip has to combine two sources of truth on purpose.
 * `pendingTriggerCount` counts only the WAITING backlog of the auto-chain —
 * it reads 0 while the chain's current trigger is in flight — so on its own
 * it would blink out exactly during the run it is meant to announce. Adding
 * the live run from the shared event stream closes that gap.
 */
export function SourcesRail({
  projectId,
  sources,
  sourceSetRevision,
  pendingTriggers,
  extractionActivity,
  referenceImport,
  hasBriefing,
}: {
  projectId: string;
  sources: SourceRowVM[];
  sourceSetRevision: number;
  pendingTriggers: number;
  /** How the last extraction pass ended — the durable half of the run state
   * the deleted extraction page used to show, kept because an extraction
   * that produced nothing would otherwise fail silently. */
  extractionActivity: ExtractionActivity;
  referenceImport: ReferenceImportVM | null;
  hasBriefing: boolean;
}) {
  const { activeRun } = useProjectEvents();
  const [sweepState, sweepAction, sweepPending] = useActionState(
    startUnevidencedExtractionAction.bind(null, projectId),
    sweepInitial,
  );
  const { blockedBy } = useStartGate("extraction");

  // `useStartGate("extraction")` reports null while an EXTRACTION run is
  // live — by design, so the panel that started it shows progress instead of
  // gating itself. The deleted ExtractionPanel compensated with a `watching`
  // flag; here the shared stream's active run does it, for the sweep button
  // and for every source row's re-extract alike.
  const extractionRunning = activeRun?.kind === "extraction";
  const chainRunning =
    extractionRunning || activeRun?.kind === "existence_check";
  const chainLabel =
    activeRun?.kind === "existence_check"
      ? "Existenzprüfung läuft …"
      : extractionRunning
        ? "Extraktion läuft …"
        : pendingTriggers > 0
          ? "Extraktion ausstehend"
          : null;

  return (
    <section className="space-y-4">
      <div className="rounded-md border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-700">
            Quellen ({sources.length})
          </h2>
          <span
            title="Der Quellenbestand wird bei jeder Quellenrevision hochgezählt – er datiert die Evidenzlage, gegen die geprüft wurde."
            className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
          >
            Bestand Rev. {sourceSetRevision}
          </span>
          {chainLabel !== null ? (
            <span
              className={`ml-auto rounded-full px-2 py-0.5 text-xs ${
                chainRunning
                  ? "bg-blue-100 text-blue-800"
                  : "bg-amber-100 text-amber-800"
              }`}
            >
              {chainLabel}
            </span>
          ) : null}
        </div>
        {sources.length === 0 ? (
          <p className="px-4 py-5 text-sm text-slate-500">
            Noch keine Quellen erfasst.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {sources.map((source) => (
              <SourceRow
                key={source.id}
                projectId={projectId}
                source={source}
                extractionRunning={extractionRunning}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">
          Quelle erfassen
        </h2>
        <CaptureSourceForm projectId={projectId} />
      </div>

      {referenceImport !== null ? (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">
            Referenzen aus dem Briefing importieren
          </h2>
          <p className="mt-1 mb-3 text-xs text-slate-600">
            Durchsucht das eingefrorene Briefing nach zitierten Quellen (DOI,
            arXiv-Id, URL sowie im Fließtext genannte Referenzen) und schlägt
            sie zur Übernahme vor.
          </p>
          <div className="space-y-4">
            <UnpaywallSettingPanel
              projectId={projectId}
              setting={referenceImport.unpaywall}
            />
            <ReferenceScanPanel
              projectId={projectId}
              state={referenceImport.scanState}
              llmAvailable={referenceImport.llmAvailable}
              lastScanMethod={referenceImport.lastScanMethod}
            />
            {referenceImport.scanState.status !== "not_started" ? (
              <p className="text-xs text-slate-600">
                {referenceImport.scanState.candidateCount} Kandidat(en) gefunden
                (
                {
                  referenceImport.candidates.filter(
                    (candidate) =>
                      candidate.capturable && !candidate.alreadyCaptured,
                  ).length
                }{" "}
                automatisch erfassbar).
              </p>
            ) : null}
            {referenceImport.candidates.length > 0 ? (
              <ReferenceCandidateReview
                projectId={projectId}
                candidates={referenceImport.candidates}
                activeRun={referenceImport.captureRunActive}
                lastOutcomes={referenceImport.captureOutcomes}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-700">
          Nachweislose Aussagen
        </h2>
        <p className="mt-1 mb-3 text-xs text-slate-600">
          Findet Aussagen des Briefings, die keine erfasste Quelle zitieren. Sie
          gehen sichtbar zur Adjudikation und werden nicht verworfen.
        </p>
        {!hasBriefing ? (
          <p className="text-xs text-amber-700">
            Vor der Extraktion muss das Briefing übernommen sein.
          </p>
        ) : extractionRunning ? (
          <p className="text-xs text-blue-800">
            Extraktion läuft – der Fortschritt steht in der Laufleiste oben.
          </p>
        ) : blockedBy ? (
          <StartBlockedNotice label={blockedBy} />
        ) : (
          <form action={sweepAction}>
            <button
              type="submit"
              disabled={sweepPending}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              {sweepPending
                ? "Wird gestartet …"
                : "Nachweislose Aussagen suchen"}
            </button>
          </form>
        )}
        <ErrorBanner message={sweepState.error} />
        {extractionActivity.lastMessage !== null ? (
          <p
            className={`mt-2 text-xs ${
              extractionActivity.lastOutcome === "failed"
                ? "text-amber-700"
                : "text-slate-500"
            }`}
          >
            Letzter Extraktionsdurchlauf: {extractionActivity.lastMessage}
          </p>
        ) : null}
      </div>
    </section>
  );
}
