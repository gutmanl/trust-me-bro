"use client";

import { useActionState, useState } from "react";

import {
  ErrorBanner,
  inputClass,
  primaryButtonClass,
} from "@/app/components/ui";
import { mintProjectId } from "@/lib/pipeline/ids";
import type { CreateProjectFormState } from "./actions";
import { createProjectAction } from "./actions";

const initialState: CreateProjectFormState = { error: null };

/**
 * Creation form. The id is suggested live from the research question but
 * remains editable until submission — afterwards id, question and creation
 * time are immutable (normative invariant of the file format).
 */
export function CreateProjectForm({
  apiBackendEnabled = false,
}: {
  /** TMB-51: shows the API spike backend option while its flag is on. */
  apiBackendEnabled?: boolean;
}) {
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
            {apiBackendEnabled ? (
              <option value="anthropic-api">
                Anthropic API (Spike, Familie anthropic)
              </option>
            ) : null}
          </select>
        </div>
      </fieldset>

      <ErrorBanner message={state.error} />

      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Wird angelegt …" : "Projekt anlegen"}
      </button>
    </form>
  );
}
