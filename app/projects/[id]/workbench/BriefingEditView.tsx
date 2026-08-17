"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  ErrorBanner,
  inputClass,
  primaryButtonClass,
} from "@/app/components/ui";
import type { BriefingDraft } from "@/lib/pipeline";
import type { BriefingFormState } from "./actions";
import {
  discardBriefingDraftAction,
  publishBriefingRevisionAction,
  saveBriefingDraftAction,
} from "./actions";

const publishInitial: BriefingFormState = { error: null };
const discardInitial: BriefingFormState = { error: null };

/** How long the editor waits after the last keystroke before storing the
 * draft. Long enough that ordinary typing produces one write per pause,
 * short enough that a user who navigates away loses at most that pause. */
const SAVE_DEBOUNCE_MS = 1500;

/**
 * The editing half of the briefing pane: a plain textarea over the whole
 * briefing, autosaved as a DRAFT (scratch storage outside the register) and
 * committed to the append-only chain only when the user publishes.
 *
 * The two-step is the point. Editing a frozen briefing is a legitimate act —
 * a wrong passage should be correctable — but it must never happen silently:
 * the draft is invisible to every projection until „Revision veröffentlichen"
 * turns it into one audited `briefing_revised` event (with the silent
 * re-anchor pass following the claims whose quotes moved).
 */
export function BriefingEditView({
  projectId,
  initialText,
  draft,
  onLeaveEditMode,
}: {
  projectId: string;
  /** Draft text if one exists, else the currently frozen briefing. */
  initialText: string;
  draft: BriefingDraft | null;
  onLeaveEditMode: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [savedAt, setSavedAt] = useState<string | null>(
    draft?.saved_at ?? null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Text typed but not yet handed to a save call; null once it has been.
   * The debounce means there is always a window in which the newest
   * keystrokes exist only here — leaving the editor used to clear the timer
   * and drop them, which is the silent loss this component's contract above
   * rules out. Flushing on the way out closes the window.
   */
  const unsaved = useRef<string | null>(null);

  const [publishState, publishAction, publishPending] = useActionState(
    publishBriefingRevisionAction.bind(null, projectId),
    publishInitial,
  );
  const [discardState, discardAction, discardPending] = useActionState(
    discardBriefingDraftAction.bind(null, projectId),
    discardInitial,
  );

  // A successful publish or discard leaves nothing to edit: the text either
  // IS the briefing now or was thrown away. Deliberately an effect, not the
  // render-phase adjustment used elsewhere in this codebase — the state being
  // set belongs to the PARENT, and setting that during this component's
  // render is exactly the case React rejects.
  const leave = useRef(onLeaveEditMode);
  useEffect(() => {
    leave.current = onLeaveEditMode;
  });
  useEffect(() => {
    if (publishState.published === true || discardState.discarded === true) {
      // Drop the pending keystrokes BEFORE leaving, so the unmount flush
      // below finds nothing to write. Both actions clear the draft
      // server-side; a flush firing after that would write it straight back
      // — a phantom "unsaved revision" after a publish, and after a discard
      // the very text the user just asked to throw away. The save carries no
      // revalidation, so neither would surface until the next full reload.
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      unsaved.current = null;
      leave.current();
    }
  }, [publishState, discardState]);

  // `useCallback` over `projectId` alone: the body reads only refs and that
  // one prop, so the identity is stable for the component's whole life and
  // the unmount effect below can depend on it honestly.
  const flush = useCallback((): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const value = unsaved.current;
    if (value === null) {
      return;
    }
    unsaved.current = null;
    // No state updates: every caller is on its way to unmounting this view,
    // so the save is fire-and-forget — the draft it writes is what the next
    // entry into edit mode reads back.
    void saveBriefingDraftAction(projectId, value);
  }, [projectId]);

  // Covers the paths that do not go through the "Ansicht" button: a route
  // change, the pane collapsing, the claim selection re-rendering the parent.
  useEffect(() => () => flush(), [flush]);

  const change = (value: string): void => {
    setText(value);
    setSaveError(null);
    unsaved.current = value;
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      unsaved.current = null;
      setSaving(true);
      void saveBriefingDraftAction(projectId, value).then((result) => {
        setSaving(false);
        setSaveError(result.error);
        if (result.savedAt !== undefined) {
          setSavedAt(result.savedAt);
        }
      });
    }, SAVE_DEBOUNCE_MS);
  };

  const pending = publishPending || discardPending;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {saving
            ? "Entwurf wird gespeichert …"
            : savedAt !== null
              ? "Entwurf gespeichert."
              : "Änderungen werden automatisch als Entwurf gespeichert."}
        </p>
        <button
          type="button"
          onClick={() => {
            flush();
            onLeaveEditMode();
          }}
          className="text-xs text-slate-500 underline decoration-slate-300 hover:text-slate-700"
        >
          Ansicht
        </button>
      </div>

      <textarea
        aria-label="Briefing bearbeiten"
        value={text}
        onChange={(event) => change(event.target.value)}
        rows={28}
        className={`${inputClass} font-mono text-xs leading-relaxed`}
      />

      <ErrorBanner message={saveError} />
      <ErrorBanner message={publishState.error} />
      <ErrorBanner message={discardState.error} />

      <div className="flex flex-wrap gap-2">
        <form action={publishAction}>
          <input type="hidden" name="text" value={text} readOnly />
          <button
            type="submit"
            disabled={pending || text.trim().length === 0}
            className={primaryButtonClass}
          >
            {publishPending
              ? "Wird veröffentlicht …"
              : "Fassung veröffentlichen"}
          </button>
        </form>
        <form action={discardAction}>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {discardPending ? "Wird verworfen …" : "Entwurf verwerfen"}
          </button>
        </form>
      </div>

      <p className="text-xs text-slate-500">
        Veröffentlichen schreibt eine neue Briefing-Fassung in den
        unveränderlichen Verlauf; die bisherige Fassung bleibt erhalten. Die
        Textstellen von Aussagen, deren zitierter Wortlaut sich verschoben hat,
        werden dabei automatisch nachgeführt.
      </p>
    </div>
  );
}
