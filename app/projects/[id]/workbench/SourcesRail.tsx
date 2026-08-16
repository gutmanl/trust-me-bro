"use client";

import { useActionState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import { useProjectEvents } from "@/app/lib/ProjectEventStream";
import { formatTimestamp } from "../../status-labels";
import { useItemLiveStatus } from "@/app/lib/useItemLiveStatus";
import type {
  ExtractionActivity,
  OpenChainTrigger,
  ReferenceScanState,
  RepairActionVM,
  ReviewCandidate,
  SourceWorkItemVM,
  UnpaywallSetting,
} from "@/lib/pipeline";
import {
  runKindLabel,
  StartBlockedNotice,
  useStartGate,
} from "../RunStatusProvider";
import {
  CandidateRow,
  CaptureReadyCandidatesButton,
} from "../sources/ReferenceCandidateReview";
import {
  ReferenceScanButton,
  ReferenceScanNotices,
} from "../sources/ReferenceScanPanel";
import { CaptureSourceButton } from "../sources/SourceForms";
import { UnpaywallSettingPanel } from "../sources/UnpaywallSettingPanel";
import type { RunFormState } from "./actions";
import { startUnevidencedExtractionAction } from "./actions";
import { SourceRow, type SourceRowVM } from "./SourceRow";
import { WorkItemRow } from "./WorkItemRow";

/** Everything the reference auto-import needs; null before a briefing
 * exists, because there is nothing to scan for references in. Capture run
 * state and outcomes are gone (source work items): candidates join the
 * unified list and their capture state IS their work item. */
export interface ReferenceImportVM {
  scanState: ReferenceScanState;
  unpaywall: UnpaywallSetting;
  candidates: ReviewCandidate[];
  llmAvailable: boolean;
  lastScanMethod?: "regex" | "regex+llm";
}

const sweepInitial: RunFormState = { error: null };

/** The run kinds the auto-chain drives, in the order they chain: a published
 * briefing enters at the reference scan and leaves after the existence
 * check. Kinds outside this set (verification, relevance, …) belong to other
 * panels — the shared status bar reports those. Only the membership lives
 * here; the labels stay in RunStatusProvider's one map, so this chip and the
 * status bar above it can never name the same run differently. */
const CHAIN_KINDS = new Set([
  "reference_scan",
  "source_capture",
  "extraction",
  "existence_check",
]);

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
  workItems,
  repairSuggestions,
  sourceSetRevision,
  pendingTriggers,
  interruptedTriggers,
  extractionActivity,
  referenceImport,
  hasBriefing,
}: {
  projectId: string;
  sources: SourceRowVM[];
  /** Queued/capturing/failed capture work items — the not-yet-sources half
   * of the unified list (source work items). */
  workItems: SourceWorkItemVM[];
  /** Open repair suggestions (automatic repair), joined onto their failed
   * work item or their target source's row. */
  repairSuggestions: RepairActionVM[];
  sourceSetRevision: number;
  pendingTriggers: number;
  /** Open evaluator brackets (run visibility): chain steps a crash, cancel
   * or deadline cut off. Informational — each re-runs organically. */
  interruptedTriggers: OpenChainTrigger[];
  /** How the last extraction pass ended — the durable half of the run state
   * the deleted extraction page used to show, kept because an extraction
   * that produced nothing would otherwise fail silently. */
  extractionActivity: ExtractionActivity;
  referenceImport: ReferenceImportVM | null;
  hasBriefing: boolean;
}) {
  const { activeRun, activity } = useProjectEvents();
  const [sweepState, sweepAction, sweepPending] = useActionState(
    startUnevidencedExtractionAction.bind(null, projectId),
    sweepInitial,
  );
  const { blockedBy } = useStartGate("extraction");
  // Live per-item state from the shared stream: which capture work item and
  // which source's extraction pass are running RIGHT NOW — the server VM
  // only knows the state as of its render.
  const capturingItems = useItemLiveStatus("source_capture");
  const extractingSources = useItemLiveStatus("extraction");

  // The unified list's row buckets. A candidate's capture state IS its work
  // item (same id), rendered on the candidate row — so those work items must
  // not ALSO render as standalone rows; only orphans (candidate rescanned
  // away) keep their own row. Correction items render as state on their
  // target source's row for the same reason (source correction).
  const openCandidates =
    referenceImport?.candidates.filter(
      (candidate) => !candidate.alreadyCaptured,
    ) ?? [];
  const openCandidateIds = new Set(
    openCandidates.map((candidate) => candidate.candidate_id),
  );
  const workItemByCandidate = new Map(
    workItems
      // An auto-repair retry of a failed reference-import candidate keeps
      // the candidate's work-item id — its live state belongs on the
      // candidate row too.
      .filter(
        (item) =>
          item.origin === "reference_import" ||
          (item.origin === "auto_repair" && item.targetSourceId === undefined),
      )
      .map((item) => [item.workItemId, item]),
  );
  // ALL correction items per source, not just the latest: a fresh
  // correction may be running while an earlier attempt's open failure is
  // still on the books — the row must show both (live progress AND every
  // failure's retry/dismiss), or the loser of a per-source collision would
  // render nowhere. Auto-repair items targeting a source render there too.
  const correctionsBySource = new Map<string, SourceWorkItemVM[]>();
  for (const item of workItems) {
    if (
      (item.origin === "correction" || item.origin === "auto_repair") &&
      item.targetSourceId !== undefined
    ) {
      const list = correctionsBySource.get(item.targetSourceId) ?? [];
      list.push(item);
      correctionsBySource.set(item.targetSourceId, list);
    }
  }
  const standaloneWorkItems = workItems.filter((item) => {
    if (item.origin === "correction" || item.targetSourceId !== undefined) {
      // Renders as state on the target source's row.
      return false;
    }
    if (item.origin === "manual") {
      return true;
    }
    // reference_import and target-less auto_repair items render on their
    // candidate's row while that candidate is still open.
    return !openCandidateIds.has(item.workItemId);
  });
  const suggestionByWorkItem = new Map(
    repairSuggestions.flatMap((entry) =>
      entry.target.kind === "capture_failure"
        ? [[entry.target.workItemId, entry] as const]
        : [],
    ),
  );
  const suggestionBySource = new Map(
    repairSuggestions.flatMap((entry) =>
      entry.target.kind === "source"
        ? [[entry.target.sourceId, entry] as const]
        : [],
    ),
  );
  const readyCandidateCount = openCandidates.filter(
    (candidate) => candidate.selected,
  ).length;

  // `useStartGate("extraction")` reports null while an EXTRACTION run is
  // live — by design, so the panel that started it shows progress instead of
  // gating itself. The deleted ExtractionPanel compensated with a `watching`
  // flag; here the shared stream's active run does it, for the sweep button
  // and for every source row's re-extract alike.
  const extractionRunning = activeRun?.kind === "extraction";
  // The chain carries four kinds now: a published briefing enters it at
  // reference_scan and leaves it at existence_check. `pendingTriggers` cannot
  // say WHICH of them is waiting (the auto-chain deliberately exposes only a
  // count), so the waiting label has to name the chain rather than a step.
  const runningLabel =
    activeRun?.kind && CHAIN_KINDS.has(activeRun.kind)
      ? `${runKindLabel(activeRun.kind)} läuft …`
      : activity?.source === "trigger"
        ? // The off-runner chain steps (run visibility): repair evaluation,
          // anchor sweep, briefing substitution — named per instance by the
          // server-computed description, never a blank chip while one runs.
          `${activity.description} läuft …`
        : undefined;
  const chainRunning = runningLabel !== undefined;
  const chainLabel =
    runningLabel ??
    (pendingTriggers > 0 ? "Automatischer Folgeschritt ausstehend" : null);

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
          <div className="ml-auto flex items-center gap-2">
            {chainLabel !== null ? (
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  chainRunning
                    ? "bg-blue-100 text-blue-800"
                    : "bg-amber-100 text-amber-800"
                }`}
              >
                {chainLabel}
              </span>
            ) : null}
            {interruptedTriggers.length > 0 ? (
              <span
                title={interruptedTriggers
                  .map(
                    (entry) =>
                      `${entry.description}${entry.sourceId ? ` (${entry.sourceId})` : ""} – unterbrochen seit ${formatTimestamp(entry.since)}; wird beim nächsten passenden Lauf automatisch nachgeholt.`,
                  )
                  .join("\n")}
                className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700"
              >
                {interruptedTriggers.length} Folgeschritt(e) unterbrochen
              </span>
            ) : null}
            {referenceImport !== null ? (
              <ReferenceScanButton
                projectId={projectId}
                state={referenceImport.scanState}
              />
            ) : null}
            <CaptureSourceButton projectId={projectId} />
          </div>
        </div>
        {sources.length === 0 &&
        standaloneWorkItems.length === 0 &&
        openCandidates.length === 0 ? (
          <p className="px-4 py-5 text-sm text-slate-500">
            Noch keine Quellen erfasst – oben rechts eine Quelle erfassen.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {standaloneWorkItems.map((item) => (
              <WorkItemRow
                key={item.workItemId}
                projectId={projectId}
                item={item}
                liveCapturing={capturingItems.has(item.workItemId)}
                suggestion={suggestionByWorkItem.get(item.workItemId)}
              />
            ))}
            {openCandidates.map((candidate) => (
              <CandidateRow
                key={candidate.candidate_id}
                projectId={projectId}
                candidate={candidate}
                workItem={workItemByCandidate.get(candidate.candidate_id)}
                liveCapturing={capturingItems.has(candidate.candidate_id)}
              />
            ))}
            {sources.map((source) => {
              const corrections = correctionsBySource.get(source.id) ?? [];
              return (
                <SourceRow
                  key={source.id}
                  projectId={projectId}
                  source={source}
                  extractionRunning={extractionRunning}
                  extractingLive={extractingSources.has(source.id)}
                  corrections={corrections}
                  correctingLive={corrections.some((item) =>
                    capturingItems.has(item.workItemId),
                  )}
                  suggestion={suggestionBySource.get(source.id)}
                />
              );
            })}
          </ul>
        )}

        {referenceImport !== null ? (
          <div className="space-y-3 border-t border-slate-100 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              {referenceImport.scanState.status !== "not_started" ? (
                <p className="text-xs text-slate-600">
                  Referenz-Scan: {referenceImport.scanState.candidateCount}{" "}
                  Kandidat(en) gefunden –{" "}
                  {
                    referenceImport.candidates.filter(
                      (candidate) => candidate.alreadyCaptured,
                    ).length
                  }{" "}
                  bereits erfasst, {openCandidates.length} offen.
                </p>
              ) : (
                <p className="text-xs text-slate-600">
                  Der Referenz-Scan läuft automatisch nach der Übernahme des
                  Briefings und nach jeder Revision mit geändertem Text; die
                  gefundenen Kandidaten erscheinen als Zeilen in dieser Liste.
                </p>
              )}
              {readyCandidateCount > 0 ? (
                <CaptureReadyCandidatesButton
                  projectId={projectId}
                  count={readyCandidateCount}
                />
              ) : null}
            </div>
            <ReferenceScanNotices
              state={referenceImport.scanState}
              llmAvailable={referenceImport.llmAvailable}
              lastScanMethod={referenceImport.lastScanMethod}
            />
            <details>
              <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700">
                Einstellungen für den automatischen Import
              </summary>
              <div className="mt-2">
                <UnpaywallSettingPanel
                  projectId={projectId}
                  setting={referenceImport.unpaywall}
                />
              </div>
            </details>
          </div>
        ) : null}
      </div>

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
