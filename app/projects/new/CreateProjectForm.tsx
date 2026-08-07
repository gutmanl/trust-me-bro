"use client";

import { useActionState, useState } from "react";

import { mintProjectId } from "@/lib/pipeline/ids";
import type { CreateProjectFormState } from "./actions";
import { createProjectAction } from "./actions";

const initialState: CreateProjectFormState = { error: null };

const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm " +
  "focus:border-slate-500 focus:outline-none";

/**
 * Creation form. The id is suggested live from the research question but
 * remains editable until submission — afterwards id, question and creation
 * time are immutable (normative invariant of the file format).
 */
export function CreateProjectForm() {
  const [state, formAction, pending] = useActionState(
    createProjectAction,
    initialState,
  );
  const [id, setId] = useState("proj_projekt");
  const [idTouched, setIdTouched] = useState(false);

  return (
    <form action={formAction} className="space-y-5">
      <div>
        <label
          htmlFor="research_question"
          className="mb-1 block text-sm font-medium"
        >
          Recherchefrage
        </label>
        <textarea
          id="research_question"
          name="research_question"
          required
          rows={2}
          className={inputClass}
          placeholder="z. B. Reduzieren LLM-gestützte Code-Reviews die Reviewzeit?"
          onChange={(event) => {
            if (!idTouched) {
              setId(mintProjectId(event.target.value));
            }
          }}
        />
        <p className="mt-1 text-xs text-slate-500">
          Nach der Anlage unveränderlich – eine geänderte Recherchefrage ist per
          Definition ein neues Projekt.
        </p>
      </div>

      <div>
        <label htmlFor="id" className="mb-1 block text-sm font-medium">
          Projekt-Id
        </label>
        <input
          id="id"
          name="id"
          required
          value={id}
          onChange={(event) => {
            setIdTouched(true);
            setId(event.target.value);
          }}
          className={`${inputClass} font-mono`}
        />
        <p className="mt-1 text-xs text-slate-500">
          Wird Verzeichnisname im Workspace; Kleinbuchstaben, Ziffern,
          &quot;.&quot;, &quot;_&quot;, &quot;-&quot;.
        </p>
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="primary_cli"
            className="mb-1 block text-sm font-medium"
          >
            Primäre Modellfamilie
          </label>
          <select
            id="primary_cli"
            name="primary_cli"
            defaultValue="claude"
            className={inputClass}
          >
            <option value="claude">Claude Code (Anthropic)</option>
            <option value="codex">Codex CLI (OpenAI)</option>
          </select>
        </div>
        <div>
          <label
            htmlFor="secondary_cli"
            className="mb-1 block text-sm font-medium"
          >
            Zweite Modellfamilie (Divergenzregel)
          </label>
          <select
            id="secondary_cli"
            name="secondary_cli"
            defaultValue="codex"
            className={inputClass}
          >
            <option value="">Keine – Divergenzregel deaktiviert</option>
            <option value="claude">Claude Code (Anthropic)</option>
            <option value="codex">Codex CLI (OpenAI)</option>
          </select>
        </div>
      </fieldset>

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
        {pending ? "Wird angelegt …" : "Projekt anlegen"}
      </button>
    </form>
  );
}
