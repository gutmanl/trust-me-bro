"use client";

import { useActionState } from "react";

import type { ImportBriefingFormState } from "./actions";
import { importBriefingAction } from "./actions";

const initialState: ImportBriefingFormState = { error: null };

const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm " +
  "focus:border-slate-500 focus:outline-none";

export function BriefingForm({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState(
    importBriefingAction.bind(null, projectId),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-5">
      <div>
        <label htmlFor="tool" className="mb-1 block text-sm font-medium">
          Erzeugendes Werkzeug
        </label>
        <input
          id="tool"
          name="tool"
          required
          placeholder="z. B. you.com Research"
          className={inputClass}
        />
        <p className="mt-1 text-xs text-slate-500">
          Wird als Provenienz im Import-Ereignis festgehalten.
        </p>
      </div>

      <div>
        <label htmlFor="file" className="mb-1 block text-sm font-medium">
          Briefing-Datei (Markdown/Text)
        </label>
        <input
          id="file"
          name="file"
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium"
        />
      </div>

      <div>
        <label htmlFor="content" className="mb-1 block text-sm font-medium">
          … oder Text einfügen
        </label>
        <textarea
          id="content"
          name="content"
          rows={12}
          className={`${inputClass} font-mono text-xs`}
          placeholder="Inhalt des generierten Briefings"
        />
        <p className="mt-1 text-xs text-slate-500">
          Eine hochgeladene Datei hat Vorrang vor eingefügtem Text. Die
          Originalfassung wird unveränderlich eingefroren – ein Briefing je
          Projekt.
        </p>
      </div>

      {state.error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {pending ? "Wird eingefroren …" : "Briefing importieren und einfrieren"}
      </button>
    </form>
  );
}
