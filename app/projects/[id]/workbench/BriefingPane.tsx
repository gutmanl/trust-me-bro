"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";

import { ResearchHub } from "@/app/components/ResearchHub";
import {
  ErrorBanner,
  inputClass,
  primaryButtonClass,
} from "@/app/components/ui";
import type {
  BriefingDraft,
  BriefingViewModel,
  EvidenceDisplay,
  QueueEntry,
} from "@/lib/pipeline";
import type { BriefingImport } from "@/lib/register";
import { formatTimestamp } from "../../status-labels";
import type { BriefingFormState } from "./actions";
import { publishBriefingRevisionAction } from "./actions";
import { BriefingEditView } from "./BriefingEditView";
import { BriefingReadView } from "./BriefingReadView";

/**
 * The briefing half of the workbench, in one of three states:
 *
 * - no briefing yet → the paste-import form (which is also the only import
 *   path now that the staged briefing page is gone),
 * - view → the reading column with the claim margin cards,
 * - edit → the autosaving textarea over the whole briefing.
 *
 * A saved draft is announced in view mode rather than silently resumed: an
 * unpublished edit that nobody remembers making is the one way this
 * workflow could quietly diverge from the frozen text.
 */
export function BriefingPane({
  projectId,
  researchQuestion,
  briefing,
  briefingText,
  briefingMeta,
  draft,
  queue,
  evidenceDisplay,
  selectedClaimId,
  selectedEvidenceId,
  hoveredParagraph,
  currentSeconds,
  onSelectClaim,
  onHoverParagraph,
}: {
  projectId: string;
  researchQuestion: string;
  briefing: BriefingViewModel | null;
  /** The frozen briefing's text, or null before the first import. */
  briefingText: string | null;
  /** Provenance of the currently frozen briefing, or null before import. */
  briefingMeta: BriefingImport | null;
  draft: BriefingDraft | null;
  queue: QueueEntry[];
  evidenceDisplay: Record<string, EvidenceDisplay>;
  selectedClaimId: string | null;
  selectedEvidenceId: string | null;
  hoveredParagraph: number | null;
  currentSeconds: () => number;
  onSelectClaim: (claimId: string, evidenceId?: string) => void;
  onHoverParagraph: (index: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (briefing === null || briefingText === null || briefingMeta === null) {
    return (
      <BriefingImportPane
        projectId={projectId}
        researchQuestion={researchQuestion}
        draft={draft}
      />
    );
  }

  return (
    <section className="rounded-md border border-slate-200 bg-white p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-700">Briefing</h2>
        {editing ? null : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            Briefing bearbeiten
          </button>
        )}
      </div>

      {editing ? null : <BriefingProvenance meta={briefingMeta} />}

      {editing ? (
        <BriefingEditView
          projectId={projectId}
          initialText={draft?.text ?? briefingText}
          draft={draft}
          onLeaveEditMode={() => setEditing(false)}
        />
      ) : (
        <>
          {draft !== null ? (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <p>
                Ungespeicherte Überarbeitung vorhanden – weiterbearbeiten oder
                verwerfen
              </p>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="ml-auto rounded-md border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                Briefing bearbeiten
              </button>
            </div>
          ) : null}
          <BriefingReadView
            projectId={projectId}
            briefing={briefing}
            queue={queue}
            evidenceDisplay={evidenceDisplay}
            selectedClaimId={selectedClaimId}
            selectedEvidenceId={selectedEvidenceId}
            hoveredParagraph={hoveredParagraph}
            currentSeconds={currentSeconds}
            onSelectClaim={onSelectClaim}
            onHoverParagraph={onHoverParagraph}
          />
        </>
      )}
    </section>
  );
}

/**
 * Which briefing this is: revision, generating tool, freeze time and the
 * checksum. Compact by design — one line, with the full hash behind a
 * disclosure — but not optional: the register can now hold SEVERAL briefing
 * revisions, and a page that shows the current text without saying which
 * revision it is, or which tool wrote it, hides exactly the provenance this
 * application exists to keep. Absence of `revision` means revision 1 (the
 * additive-field convention the format uses).
 */
function BriefingProvenance({ meta }: { meta: BriefingImport }) {
  return (
    <div className="mb-4 border-b border-slate-100 pb-3 text-xs text-slate-500">
      <p className="flex flex-wrap gap-x-3 gap-y-1">
        <span>
          Revision <span className="font-semibold">{meta.revision ?? 1}</span>
        </span>
        <span>
          Werkzeug: <span className="font-mono">{meta.tool}</span>
        </span>
        <span>Eingefroren: {formatTimestamp(meta.imported_at)}</span>
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer">
          SHA-256 der Originalfassung
        </summary>
        <p className="mt-1 font-mono break-all text-slate-600">{meta.sha256}</p>
      </details>
    </div>
  );
}

const importInitial: BriefingFormState = { error: null };

/**
 * Empty state: the briefing arrives here, by paste. Publishing without a
 * prior briefing is the initial import in the pipeline — hence the tool
 * name, which is recorded as provenance and can only be given once.
 */
function BriefingImportPane({
  projectId,
  researchQuestion,
  draft,
}: {
  projectId: string;
  researchQuestion: string;
  draft: BriefingDraft | null;
}) {
  const [state, formAction, pending] = useActionState(
    publishBriefingRevisionAction.bind(null, projectId),
    importInitial,
  );
  const toolInputRef = useRef<HTMLInputElement>(null);

  return (
    <section className="rounded-md border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-700">Briefing</h2>
      <p className="mt-1 text-sm text-slate-600">
        Noch kein Briefing übernommen. Den Text des recherchierten Briefings
        hier einfügen – die Originalfassung wird unveränderlich eingefroren und
        ist ab dann die Grundlage jeder Prüfung.
      </p>

      <form action={formAction} className="mt-4 space-y-4">
        <div>
          <label htmlFor="tool" className="mb-1 block text-sm font-medium">
            Erzeugendes Werkzeug
          </label>
          <input
            id="tool"
            name="tool"
            required
            ref={toolInputRef}
            placeholder="z. B. you.com Research"
            className={inputClass}
          />
          <p className="mt-1 text-xs text-slate-500">
            Wird als Provenienz im Import-Ereignis festgehalten.
          </p>
        </div>
        <div>
          <label htmlFor="text" className="mb-1 block text-sm font-medium">
            Briefing-Text
          </label>
          <textarea
            id="text"
            name="text"
            rows={16}
            required
            defaultValue={draft?.text ?? ""}
            placeholder="Inhalt des generierten Briefings"
            className={`${inputClass} font-mono text-xs`}
          />
        </div>
        <ErrorBanner message={state.error} />
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Wird eingefroren …" : "Briefing übernehmen"}
        </button>
      </form>

      <p className="mt-4 text-sm text-slate-500">
        Lieber in der Anwendung recherchieren?{" "}
        <Link
          href={`/projects/${projectId}/research`}
          className="underline decoration-slate-300 hover:text-slate-700"
        >
          Zur Erstrecherche
        </Link>
        .
      </p>

      <div className="mt-4 border-t border-slate-100 pt-4">
        <ResearchHub
          question={researchQuestion}
          compact
          onToolChosen={(tool) => {
            if (toolInputRef.current) {
              toolInputRef.current.value = tool.name;
            }
          }}
        />
      </div>
    </section>
  );
}
