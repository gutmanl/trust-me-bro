"use client";

import { useActionState, useState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import { archiveProjectAction, type ArchiveProjectFormState } from "./actions";

const initialState: ArchiveProjectFormState = { error: null };

const subtleButtonClass =
  "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs " +
  "font-medium text-slate-600 hover:border-slate-500 disabled:opacity-50";

/**
 * Archive control for one project card on the list. Sits OUTSIDE the card's
 * <Link> (a form may not nest in an anchor, and a stray click must not both
 * navigate and archive). Two steps: an "Archivieren" button reveals an inline
 * "Archivieren?" confirm — archiving moves the project to the workspace's
 * .trash and is recoverable, so a one-click confirm is proportionate; no
 * type-the-name gate. The server refuses while a run is active for the
 * project, surfaced here as the form error.
 */
export function ArchiveProjectControl({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState(
    archiveProjectAction.bind(null, projectId),
    initialState,
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col items-end gap-1">
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Archivieren?</span>
          <form action={formAction}>
            <button
              type="submit"
              disabled={pending}
              className={subtleButtonClass}
            >
              {pending ? "Wird archiviert …" : "Ja, archivieren"}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={pending}
            className={subtleButtonClass}
          >
            Abbrechen
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={subtleButtonClass}
        >
          Archivieren
        </button>
      )}
      {state.error ? <ErrorBanner message={state.error} /> : null}
    </div>
  );
}
