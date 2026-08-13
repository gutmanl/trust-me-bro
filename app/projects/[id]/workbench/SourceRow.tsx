"use client";

import { useActionState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import type { CaptureKind, SourceWorkItemVM } from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";
import { formatTimestamp } from "../../status-labels";
import { useStartGate } from "../RunStatusProvider";
import { CorrectSourceForm } from "../sources/SourceForms";
import type { RunFormState } from "./actions";
import { startSourceExtractionAction } from "./actions";
import { DismissButton, FailureBox, RetryButton } from "./WorkItemRow";

/**
 * One captured source as the workbench shows it. Assembled server-side (the
 * citation formatter and the lifecycle derivation both live in the pipeline)
 * so this stays a plain, serializable render prop.
 */
export interface SourceRowVM {
  id: string;
  citation: string;
  title?: string;
  sourceTypeLabel: string;
  /** Snapshot revision the source currently stands at. */
  revision: number;
  capturedAt: string;
  /** Non-discarded claims resting on this source. */
  citingClaims: number;
  identifierVerified: boolean;
  fullTextExtracted: boolean;
  textExtractionError?: string;
  previousSnapshots: number;
  autoCaptureNote?: string;
  /** How this source's LAST extraction pass ended (source work items),
   * from the bracket events' structured source_id; null before the first
   * attributed pass. */
  extractionOutcome: "completed" | "failed" | null;
  /** Completion reason of that pass, shown on failure. */
  extractionMessage?: string;
  /** Identifier shape of the source's current identity — prefill for the
   * correction modal's kind tabs (source correction). */
  currentKind: CaptureKind;
  /** Current classification, prefill for the correction modal's type
   * select. */
  currentSourceType: SourceType;
  /** Earlier identity corrections, for the history note. */
  previousIdentities: number;
}

const initialState: RunFormState = { error: null };

/**
 * A source row: what it is, how much of the briefing rests on it, which
 * snapshot revision that evidence was taken against — plus the two things
 * one does to a source here, revise its document and re-run its extraction
 * pass.
 */
export function SourceRow({
  projectId,
  source,
  extractionRunning,
  extractingLive,
  correction,
  correctingLive,
}: {
  projectId: string;
  source: SourceRowVM;
  /** An extraction run is live. Passed down rather than read here so all
   * the rows share the rail's one stream subscription — and needed at all
   * because `useStartGate("extraction")` reports null for its own kind. */
  extractionRunning: boolean;
  /** THIS source's extraction pass is live right now (item-keyed stream
   * state, shared via the rail like `extractionRunning`). */
  extractingLive: boolean;
  /** THIS source's pending/failed identity correction, if any (source
   * correction) — joined from the work-item list by the rail, so a
   * correction renders as state ON the source's row, never as a second
   * row for the same source. */
  correction?: SourceWorkItemVM;
  /** THIS source's correction is running right now (item-keyed stream
   * state, shared via the rail). */
  correctingLive: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    startSourceExtractionAction.bind(null, projectId, source.id),
    initialState,
  );
  const { blockedBy } = useStartGate("extraction");

  return (
    <li className="px-4 py-3">
      <p className="text-sm font-medium text-slate-800">{source.citation}</p>
      {source.title !== undefined ? (
        <p className="mt-0.5 text-xs text-slate-600">{source.title}</p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
        <span className="font-mono">{source.id}</span>
        <span>{source.sourceTypeLabel}</span>
        <span>Revision {source.revision}</span>
        <span>{formatTimestamp(source.capturedAt)}</span>
        <span>
          {source.citingClaims === 0
            ? "kein Claim gestützt"
            : `${source.citingClaims} Claim(s) gestützt`}
        </span>
        {source.identifierVerified ? (
          <span className="text-green-600">✓ Identifier verifiziert</span>
        ) : null}
        {source.fullTextExtracted ? (
          <span className="text-green-600">✓ Volltext extrahiert</span>
        ) : null}
        {source.previousSnapshots > 0 ? (
          <span>{source.previousSnapshots} frühere Revision(en)</span>
        ) : null}
        {source.previousIdentities > 0 ? <span>Kennung korrigiert</span> : null}
        {correctingLive || correction?.status === "capturing" ? (
          <span className="flex items-center gap-1 text-blue-700">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
            Kennung wird korrigiert …
          </span>
        ) : correction?.status === "queued" ? (
          <span className="text-slate-600">
            Korrektur wartet in der Warteschlange
          </span>
        ) : null}
        {extractingLive ? (
          <span className="flex items-center gap-1 text-blue-700">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
            Claims werden extrahiert …
          </span>
        ) : source.extractionOutcome === "completed" ? (
          <span className="text-green-600">✓ Claims extrahiert</span>
        ) : null}
      </div>

      {!extractingLive && source.extractionOutcome === "failed" ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          ⚠ {source.extractionMessage ?? "Letzte Extraktion ohne Ergebnis."} Der
          Extraktions-Button unten startet den Durchlauf erneut.
        </div>
      ) : null}

      {source.autoCaptureNote !== undefined ? (
        <p className="mt-1 text-xs text-slate-500">{source.autoCaptureNote}</p>
      ) : null}

      {source.textExtractionError !== undefined ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          ⚠ {source.textExtractionError}
        </div>
      ) : null}

      {!correctingLive && correction?.status === "failed" ? (
        <FailureBox>
          <p>
            ⚠ Korrektur fehlgeschlagen:{" "}
            {correction.error ?? "Unbekannter Fehler."}
            {correction.failedAt !== undefined ? (
              <span className="text-amber-700">
                {" "}
                ({formatTimestamp(correction.failedAt)})
              </span>
            ) : null}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <RetryButton
              projectId={projectId}
              workItemId={correction.workItemId}
            />
            <DismissButton
              projectId={projectId}
              workItemId={correction.workItemId}
            />
          </div>
        </FailureBox>
      ) : null}

      <CorrectSourceForm
        projectId={projectId}
        sourceId={source.id}
        currentKind={source.currentKind}
        currentSourceType={source.currentSourceType}
      />

      {blockedBy || extractionRunning ? null : (
        <form action={formAction} className="mt-1">
          <button
            type="submit"
            disabled={pending}
            className="text-xs font-medium text-slate-500 underline decoration-slate-300 hover:text-slate-700 disabled:opacity-50"
          >
            {pending
              ? "Extraktion wird gestartet …"
              : "Claims aus dieser Quelle extrahieren"}
          </button>
        </form>
      )}
      <ErrorBanner message={state.error} />
    </li>
  );
}
