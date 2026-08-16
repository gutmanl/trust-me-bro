"use client";

import { useActionState, useState } from "react";

import {
  ErrorBanner,
  inputClass,
  primaryButtonClass,
} from "@/app/components/ui";
import { mintProjectId } from "@/lib/pipeline/ids";
import type { WarmRunFormState } from "./actions";
import { createWarmRunAction } from "./actions";

const initialState: WarmRunFormState = { error: null };

export function WarmRunForm({ originProjectId }: { originProjectId: string }) {
  const [state, formAction, pending] = useActionState(
    createWarmRunAction.bind(null, originProjectId),
    initialState,
  );
  const [question, setQuestion] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [projectId, setProjectId] = useState("");

  const suggestedId = question.trim() ? mintProjectId(question) : "";
  const effectiveId = idTouched ? projectId : suggestedId;

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label
          htmlFor="research_question"
          className="mb-1 block text-sm font-medium"
        >
          Neue Recherchefrage (Folgefrage)
        </label>
        <textarea
          id="research_question"
          name="research_question"
          required
          rows={2}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-slate-500">
          Muss sich von der Frage des Ursprungsprojekts unterscheiden – eine
          geänderte Recherchefrage ist per Definition ein neues Projekt.
        </p>
      </div>
      <div>
        <label htmlFor="project_id" className="mb-1 block text-sm font-medium">
          Projekt-Id des Folgeprojekts
        </label>
        <input
          id="project_id"
          name="project_id"
          required
          value={effectiveId}
          onChange={(event) => {
            setIdTouched(true);
            setProjectId(event.target.value);
          }}
          className={`${inputClass} font-mono`}
        />
      </div>
      <ErrorBanner message={state.error} />
      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending
          ? "Wird angelegt …"
          : "Folgeprojekt anlegen und Aussagen übernehmen"}
      </button>
    </form>
  );
}
