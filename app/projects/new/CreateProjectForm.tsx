"use client";

import Link from "next/link";
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
  usableRealCliIds = [],
}: {
  /** TMB-51: shows the API spike backend option while its flag is on. */
  apiBackendEnabled?: boolean;
  /**
   * Agent CLIs the installation diagnosis found ready, `claude`/`codex`.
   * Empty means none is usable — the state a first-time evaluator is in
   * before installing anything.
   *
   * This form used to be the one action surface with no live backend signal
   * at all, while the setup wizard, the dashboard, the research panel and
   * the relevance panel all render one. The gap had a concrete cost: the
   * wizard tells a user without a CLI that the demo backend needs neither
   * installation nor account, and the very next screen then defaulted them
   * to Claude Code and created a project whose every model-backed step is
   * locked. Nothing was broken by it — the workbench surfaces the problem
   * as soon as a run is attempted — but the fix belongs at the point of
   * choice, not one screen later.
   */
  usableRealCliIds?: readonly string[];
}) {
  const noRealBackend = usableRealCliIds.length === 0;
  /** Marks an agent CLI the diagnosis could not use, so the consequence of
   * picking it is visible in the option itself rather than one screen on. */
  const cliSuffix = (cli: string): string =>
    usableRealCliIds.includes(cli) ? "" : " – nicht einsatzbereit";
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
  // Controlled like the question field, so React's automatic form reset
  // after a failed server action doesn't revert them to their defaults.
  // Defaulted from the diagnosis rather than hardcoded: offering a CLI that
  // is not installed as the pre-selected answer is the one choice here that
  // cannot work. With no real backend ready the demo backend is the only
  // selection that produces a usable project, so it is the default — and the
  // notice below says why, because a silently changed default is its own
  // kind of confusing.
  const [primaryCli, setPrimaryCli] = useState(
    noRealBackend ? "mock" : (usableRealCliIds[0] ?? "claude"),
  );
  const [secondaryCli, setSecondaryCli] = useState(
    noRealBackend ? "" : "codex",
  );
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
          // Controlled so React's automatic form reset after the server
          // action doesn't wipe the question when creation fails.
          value={question}
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

      {noRealBackend ? (
        <p
          role="status"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          Zurzeit ist keine Agenten-CLI einsatzbereit. Voreingestellt ist
          deshalb das Demo-Backend – damit läuft der Ablauf vollständig durch,
          seine Urteile sind aber keine Verifikation. Für eine echte Prüfung
          hilft die{" "}
          <Link href="/settings" className="underline">
            Einrichtungsdiagnose
          </Link>{" "}
          weiter; die Wahl lässt sich später in den Projekteinstellungen ändern.
        </p>
      ) : null}

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
            value={primaryCli}
            onChange={(event) => setPrimaryCli(event.target.value)}
            className={inputClass}
          >
            <option value="claude">
              Claude Code (Anthropic){cliSuffix("claude")}
            </option>
            <option value="codex">
              Codex CLI (OpenAI){cliSuffix("codex")}
            </option>
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
            value={secondaryCli}
            onChange={(event) => setSecondaryCli(event.target.value)}
            className={inputClass}
          >
            <option value="">Keine – Divergenzregel deaktiviert</option>
            <option value="claude">
              Claude Code (Anthropic){cliSuffix("claude")}
            </option>
            <option value="codex">
              Codex CLI (OpenAI){cliSuffix("codex")}
            </option>
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
