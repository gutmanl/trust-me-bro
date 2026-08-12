"use client";

import { useActionState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import { formatTimestamp } from "../../status-labels";
import { useStartGate } from "../RunStatusProvider";
import { ReviseSourceForm } from "../sources/SourceForms";
import type { RunFormState } from "./actions";
import { startSourceExtractionAction } from "./actions";

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
}: {
  projectId: string;
  source: SourceRowVM;
  /** An extraction run is live. Passed down rather than read here so all
   * the rows share the rail's one stream subscription — and needed at all
   * because `useStartGate("extraction")` reports null for its own kind. */
  extractionRunning: boolean;
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
      </div>

      {source.autoCaptureNote !== undefined ? (
        <p className="mt-1 text-xs text-slate-500">{source.autoCaptureNote}</p>
      ) : null}

      {source.textExtractionError !== undefined ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          ⚠ {source.textExtractionError}
        </div>
      ) : null}

      <ReviseSourceForm projectId={projectId} sourceId={source.id} />

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
