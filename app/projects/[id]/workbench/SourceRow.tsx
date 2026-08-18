"use client";

import { useActionState, useState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import type {
  CaptureKind,
  RepairActionVM,
  SourceWorkItemVM,
} from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";
import { formatTimestamp } from "../../status-labels";
// Type-only on purpose: a value import would pull `formatTimestamp` and
// `originalCaptureProvenanceLabel` into this client component for no reason.
// Erased at build time, and a relative specifier inside `app/**` besides, so
// the architecture test's `@/lib/*` runtime-import rule is untouched.
import type { OriginalIdentityRowVM } from "../original-identity-vm";
import { useStartGate } from "../RunStatusProvider";
import type { RetryCaptureState } from "../sources/actions";
import { revertSourceIdentityAction } from "../sources/actions";
import { CorrectSourceForm } from "../sources/SourceForms";
import type { RunFormState } from "./actions";
import { startSourceExtractionAction } from "./actions";
import {
  DismissButton,
  FailureBox,
  RetryButton,
  SuggestionBox,
} from "./WorkItemRow";

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
  /** The source's VERY FIRST identity, present iff it was ever corrected.
   * Display-ready strings only — the citation and the timestamp are formatted
   * server-side, no register data crosses into this component. Declared by
   * REFERENCE, not restated: `OriginalIdentityRowVM` is the single declaration
   * of this shape, so a field added there reaches this component's props
   * instead of drifting from them. The per-field docs live with it. */
  originalIdentity?: OriginalIdentityRowVM;
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
  corrections,
  correctingLive,
  suggestion,
}: {
  projectId: string;
  source: SourceRowVM;
  /** An extraction run is live. Passed down rather than read here so all
   * the rows share the rail's one stream subscription — and needed at all
   * because `useStartGate("extraction")` reports null for its own kind. */
  extractionRunning: boolean;
  /** THIS source's extraction pass is live right now (item-keyed stream
   * state, shared via the rail like `extractingLive`). */
  extractingLive: boolean;
  /** ALL of this source's pending/failed identity corrections (source
   * correction) — joined from the work-item list by the rail, so a
   * correction renders as state ON the source's row, never as a second
   * row for the same source. More than one entry is a real state: a fresh
   * correction can run while an earlier attempt's failure is still open,
   * and every open failure keeps its own retry/dismiss. */
  corrections: SourceWorkItemVM[];
  /** One of this source's corrections is running right now (item-keyed
   * stream state, shared via the rail). */
  correctingLive: boolean;
  /** Open repair suggestion targeting this source, if any (automatic
   * repair). */
  suggestion?: RepairActionVM;
}) {
  const [state, formAction, pending] = useActionState(
    startSourceExtractionAction.bind(null, projectId, source.id),
    initialState,
  );
  const { blockedBy } = useStartGate("extraction");
  const correctionInFlight =
    correctingLive || corrections.some((item) => item.status === "capturing");
  const correctionQueued = corrections.some((item) => item.status === "queued");
  const failedCorrections = corrections.filter(
    (item) => item.status === "failed",
  );

  return (
    <li className="px-4 py-3">
      <p className="text-sm font-medium text-slate-800">{source.citation}</p>
      {source.title !== undefined ? (
        <p className="mt-0.5 text-xs text-slate-600">{source.title}</p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
        <span className="font-mono">{source.id}</span>
        <span>{source.sourceTypeLabel}</span>
        <span>Fassung {source.revision}</span>
        {/* "Stand", not a bare date: this is the CURRENT snapshot's
            retrieved_at, so on a corrected source it is the correction's
            timestamp — while the original-identity block below carries an
            EARLIER date explicitly labelled "Erfasst am". Unlabelled, the later
            of the two reads as the capture date and reintroduces one line up
            exactly the ambiguity that block exists to remove. */}
        <span>Stand {formatTimestamp(source.capturedAt)}</span>
        <span>
          {source.citingClaims === 0
            ? "keine Aussage gestützt"
            : `${source.citingClaims} Aussage(n) gestützt`}
        </span>
        {source.identifierVerified ? (
          <span className="text-green-600">✓ Kennung verifiziert</span>
        ) : null}
        {source.fullTextExtracted ? (
          <span className="text-green-600">✓ Volltext extrahiert</span>
        ) : null}
        {source.previousSnapshots > 0 ? (
          <span>{source.previousSnapshots} frühere Fassung(en)</span>
        ) : null}
        {source.previousIdentities > 0 ? (
          <span className="flex items-center gap-1.5">
            Kennung korrigiert
            {source.previousSnapshots > 0 && !correctionInFlight ? (
              <RevertIdentityButton
                projectId={projectId}
                sourceId={source.id}
              />
            ) : null}
          </span>
        ) : null}
        {correctionInFlight ? (
          <span className="flex items-center gap-1 text-blue-700">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
            Kennung wird korrigiert …
          </span>
        ) : correctionQueued ? (
          <span className="text-slate-600">
            Korrektur wartet in der Warteschlange
          </span>
        ) : null}
        {extractingLive ? (
          <span className="flex items-center gap-1 text-blue-700">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
            Aussagen werden erfasst …
          </span>
        ) : source.extractionOutcome === "completed" ? (
          <span className="text-green-600">✓ Aussagen erfasst</span>
        ) : null}
      </div>

      {/* Original source identity: the citation at the top of this row is the
          CORRECTED one, so without this block nothing says what the source
          originally claimed to be — the very thing one needs to recognize it.
          Slate, not amber: amber is this row's failure colour, and an original
          identity is information, not an alarm. Rendered whenever an earlier
          identity exists AND an archived snapshot dates it — every correction
          archives one, so that is the normal state, and where it is missing the
          projection fails closed rather than date the original by the
          correction's snapshot. On no further condition than those two: after a
          revert the original and the current identity coincide, and hiding the
          block then would silently decide that the reader did not mean the one
          they can already see. The title gets its own line because the citation
          names the original by author and year only, so a correction sharing
          author and venue with the original would be told apart by its year
          alone — the row's own citation and title stack the same way directly
          above. It can be absent: an archived item without an author is already
          cited BY its title, and a title that is not a usable string is not
          shown at all rather than coerced. */}
      {source.originalIdentity !== undefined ? (
        <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs break-words text-slate-600">
          <p>
            <span className="font-medium">Ursprünglich erfasst als:</span>{" "}
            {source.originalIdentity.citation}
          </p>
          {source.originalIdentity.title !== undefined ? (
            <p>{source.originalIdentity.title}</p>
          ) : null}
          <p>
            Erfasst am {source.originalIdentity.capturedAtLabel} –{" "}
            {source.originalIdentity.provenanceLabel}
          </p>
          {source.originalIdentity.rawText !== undefined ? (
            <p>
              <span className="font-medium">Referenztext:</span>{" "}
              {`„${source.originalIdentity.rawText}“`}
            </p>
          ) : null}
        </div>
      ) : null}

      {!extractingLive && source.extractionOutcome === "failed" ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          ⚠{" "}
          {source.extractionMessage ??
            "Letzte Aussagen-Erfassung ohne Ergebnis."}{" "}
          Der Erfassungs-Button unten startet den Durchlauf erneut.
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

      {failedCorrections.map((failure) => (
        <FailureBox key={failure.workItemId}>
          <p>
            ⚠ Korrektur fehlgeschlagen: {failure.error ?? "Unbekannter Fehler."}
            {failure.failedAt !== undefined ? (
              <span className="text-amber-700">
                {" "}
                ({formatTimestamp(failure.failedAt)})
              </span>
            ) : null}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <RetryButton
              projectId={projectId}
              workItemId={failure.workItemId}
            />
            <DismissButton
              projectId={projectId}
              workItemId={failure.workItemId}
            />
          </div>
        </FailureBox>
      ))}

      {suggestion !== undefined && !correctionInFlight ? (
        <SuggestionBox projectId={projectId} suggestion={suggestion} />
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
              ? "Aussagen-Erfassung wird gestartet …"
              : "Aussagen aus dieser Quelle erfassen"}
          </button>
        </form>
      )}
      <ErrorBanner message={state.error} />
    </li>
  );
}

/**
 * "Korrektur zurücknehmen" on a source that carries an archived identity
 * (source correction): restores the previous bibliographic core and its
 * previous document in one audited step.
 *
 * Behind a confirmation because it moves the frozen corpus — the same
 * reason applying a weak suggestion is. Only rendered when BOTH an archived
 * identity and an archived document exist; restoring metadata without its
 * document would leave the source describing one work and quoting another.
 */
function RevertIdentityButton({
  projectId,
  sourceId,
}: {
  projectId: string;
  sourceId: string;
}) {
  const [state, action, pending] = useActionState(
    revertSourceIdentityAction.bind(null, projectId, sourceId),
    { error: null } as RetryCaptureState,
  );
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => {
          setArmed(true);
        }}
        className="text-xs font-medium text-slate-600 underline decoration-slate-300 hover:text-slate-900"
      >
        zurücknehmen
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-1.5">
      <span className="text-xs text-amber-800">
        Frühere Kennung und deren Dokument wiederherstellen?
      </span>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
      >
        {pending ? "Wird zurückgenommen …" : "Ja, zurücknehmen"}
      </button>
      <button
        type="button"
        onClick={() => {
          setArmed(false);
        }}
        className="text-xs text-slate-600 underline decoration-slate-300"
      >
        Abbrechen
      </button>
      <ErrorBanner message={state.error} />
    </form>
  );
}
