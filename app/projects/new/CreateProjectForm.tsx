"use client";

import { useActionState, useEffect, useState } from "react";

import { QuestionGuidance } from "@/app/components/ResearchHub";
import {
  ErrorBanner,
  inputClass,
  primaryButtonClass,
} from "@/app/components/ui";
import { assessResearchQuestion } from "@/app/lib/research-tools";
import {
  isValidProjectId,
  mintProjectId,
  PROJECT_ID_HINT,
} from "@/lib/pipeline/ids";
import type { CreateProjectFormState } from "./actions";
import { createProjectAction } from "./actions";

const initialState: CreateProjectFormState = { error: null };

/** Debounce delay for the live question-quality hints (Task 12): long
 * enough that ordinary typing doesn't re-run the heuristics on every
 * keystroke, short enough that the hints still feel live. */
const HINT_DEBOUNCE_MS = 400;

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
  // S-12: the same check the server applies, so an id that would be
  // rejected is visible as such before submitting rather than after.
  const idValid = isValidProjectId(id);

  const [question, setQuestion] = useState("");
  const [hints, setHints] = useState<ReturnType<typeof assessResearchQuestion>>(
    [],
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      setHints(question.trim() ? assessResearchQuestion(question) : []);
    }, HINT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [question]);

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
            setQuestion(event.target.value);
            if (!idTouched) {
              setId(mintProjectId(event.target.value));
            }
          }}
        />
        <p className="mt-1 text-xs text-slate-500">
          Nach der Anlage unveränderlich – eine geänderte Recherchefrage ist per
          Definition ein neues Projekt.
        </p>
        {hints.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs">
            {hints.map((hint, index) => (
              <li
                key={index}
                className={
                  hint.severity === "warnung"
                    ? "text-amber-800"
                    : "text-slate-500"
                }
              >
                {/* Severity must not be color-only (a11y) — same marker as
                 * ResearchHub's QuestionHints; the approved hint text stays
                 * untouched. */}
                {hint.severity === "warnung" ? (
                  <>
                    <span aria-hidden="true">⚠ </span>
                    <span className="sr-only">Achtung: </span>
                  </>
                ) : null}
                {hint.text}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-2">
          <QuestionGuidance />
        </div>
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
        <p
          className={`mt-1 text-xs ${
            idValid ? "text-slate-500" : "text-amber-800"
          }`}
        >
          {PROJECT_ID_HINT}
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
            <option value="mock">Demo-Backend (ohne echte Prüfung)</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Das Demo-Backend liefert vorgefertigte Ergebnisse, ohne installierte
            CLI und ohne Konto. Es dient dazu, den Ablauf kennenzulernen – seine
            Urteile sind keine Verifikation.
          </p>
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
            <option value="mock">Demo-Backend (Familie mock)</option>
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
