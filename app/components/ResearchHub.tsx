"use client";

import { useState } from "react";

import { inputClass } from "@/app/components/ui";
import {
  assessResearchQuestion,
  buildResearchPrompt,
  RESEARCH_TOOLS,
  type ResearchTool,
} from "@/app/lib/research-tools";

/**
 * Research acquisition hub (Task 12, replaces the old static
 * ResearchGuidance): where the tool guide, the deterministic prompt
 * converter and the live question-quality hints live. The tool verifies a
 * briefing that was researched somewhere else, and until now nothing in the
 * interface said so beyond a fixed prompt template — this widens that into
 * a small wizard: pick a tool, get a ready-to-paste prompt tailored to it,
 * and see live whether the research question itself is well formed before
 * spending a research run on it.
 *
 * `question` is the project's own research question where one already
 * exists (the start wizard, the research page); left undefined (setup page,
 * `compact`), the hub offers a local scratch textarea instead so the
 * guidance is still useful before a project exists.
 */

/**
 * "Was macht eine gute Recherchefrage aus?" — the same guidance content the
 * hub and the project-creation form both need, extracted so neither has to
 * duplicate it.
 */
export function QuestionGuidance() {
  return (
    <details className="rounded-md border border-slate-200 bg-slate-50 p-4">
      <summary className="cursor-pointer text-sm font-medium text-slate-700">
        Was macht eine gute Recherchefrage aus?
      </summary>
      <div className="mt-3 space-y-3 text-sm text-slate-600">
        <ul className="list-disc space-y-1 pl-5">
          <li>präzise &amp; abgegrenzt</li>
          <li>offen formuliert</li>
          <li>genau eine Frage</li>
          <li>empirisch beantwortbar mit messbaren Größen</li>
          <li>Kontext und Vergleich benannt</li>
          <li>Zeitraum eingegrenzt</li>
        </ul>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
            <p className="font-medium">Schlecht</p>
            <p className="mt-1">„Sind LLMs gut für Code-Reviews?“</p>
          </div>
          <div className="rounded-md border border-green-200 bg-green-50 p-2 text-xs text-green-800">
            <p className="font-medium">Gut</p>
            <p className="mt-1">
              „Inwiefern reduziert der Einsatz von LLM-gestützten Code-Reviews
              die Reviewzeit bei mittelgroßen Softwareprojekten im Vergleich zu
              manuellen Reviews, gemessen über die ersten sechs Monate nach
              Einführung?“
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}

/** Live hint list for a research question, in warnung/hinweis colour. */
function QuestionHints({ question }: { question: string }) {
  const hints = question.trim() ? assessResearchQuestion(question) : [];
  if (hints.length === 0) {
    return null;
  }
  return (
    <ul className="space-y-1 text-xs">
      {hints.map((hint, index) => (
        <li
          key={index}
          className={
            hint.severity === "warnung" ? "text-amber-800" : "text-slate-500"
          }
        >
          {/* Severity must not be color-only (a11y): a visible glyph plus an
           * sr-only label carries "warnung" for anyone who can't rely on
           * amber-vs-slate. The approved hint text itself stays untouched. */}
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
  );
}

function ToolCard({
  tool,
  selected,
  onSelect,
}: {
  tool: ResearchTool;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-xs ${
        selected
          ? "border-slate-500 bg-slate-50"
          : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <input
            type="radio"
            name="research-tool"
            checked={selected}
            onChange={onSelect}
            className="h-3.5 w-3.5"
          />
          <span className="text-sm font-medium text-slate-800">
            {tool.name}
          </span>
        </span>
        {tool.url ? (
          <a
            href={tool.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-slate-500 underline decoration-slate-300 hover:text-slate-700 hover:decoration-slate-600"
            onClick={(event) => event.stopPropagation()}
          >
            Öffnen ↗
          </a>
        ) : null}
      </span>
      <p className="text-slate-600">{tool.mode}</p>
      <p className="text-slate-600">
        <strong className="font-medium text-slate-700">Stärken:</strong>{" "}
        {tool.strengths}
      </p>
      <p className="text-slate-600">
        <strong className="font-medium text-slate-700">Achtung:</strong>{" "}
        {tool.caveats}
      </p>
    </label>
  );
}

function ResearchHubBody({
  question,
  onToolChosen,
}: {
  question?: string;
  onToolChosen?: (tool: ResearchTool) => void;
}) {
  const [localQuestion, setLocalQuestion] = useState("");
  const effectiveQuestion = question ?? localQuestion;
  const [selectedToolId, setSelectedToolId] = useState<
    ResearchTool["id"] | null
  >(null);
  const [copied, setCopied] = useState(false);

  const selectedTool =
    RESEARCH_TOOLS.find((tool) => tool.id === selectedToolId) ?? null;
  const trimmedQuestion = effectiveQuestion.trim();
  const prompt =
    selectedTool && trimmedQuestion
      ? buildResearchPrompt(effectiveQuestion, selectedTool.id)
      : null;

  const selectTool = (tool: ResearchTool) => {
    setSelectedToolId(tool.id);
    setCopied(false);
    onToolChosen?.(tool);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Diese Anwendung prüft ein Briefing – recherchiert wird außerhalb oder
        per Erstrecherche in der Anwendung.
      </p>

      <QuestionGuidance />

      {question === undefined ? (
        <div>
          <label
            htmlFor="research-hub-question"
            className="mb-1 block text-sm font-medium"
          >
            Recherchefrage
          </label>
          <textarea
            id="research-hub-question"
            rows={2}
            value={localQuestion}
            onChange={(event) => setLocalQuestion(event.target.value)}
            placeholder="z. B. Reduzieren LLM-gestützte Code-Reviews die Reviewzeit?"
            className={inputClass}
          />
        </div>
      ) : null}

      <QuestionHints question={effectiveQuestion} />

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">
          Recherche-Werkzeug wählen
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {RESEARCH_TOOLS.map((tool) => (
            <ToolCard
              key={tool.id}
              tool={tool}
              selected={selectedTool?.id === tool.id}
              onSelect={() => selectTool(tool)}
            />
          ))}
        </div>
      </fieldset>

      {prompt ? (
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-slate-700">
              Recherche-Prompt für {selectedTool?.name}
            </p>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(prompt)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-500"
            >
              {copied ? "Kopiert" : "In die Zwischenablage kopieren"}
            </button>
          </div>
          <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-slate-200 bg-white p-3 font-mono text-xs whitespace-pre-wrap text-slate-700">
            {prompt}
          </pre>
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          {trimmedQuestion
            ? "Werkzeug auswählen, um die passende Prompt-Vorlage zu erzeugen."
            : "Recherchefrage angeben, um eine Prompt-Vorlage zu erzeugen."}
        </p>
      )}
    </div>
  );
}

export function ResearchHub({
  question,
  onToolChosen,
  compact = false,
}: {
  question?: string;
  onToolChosen?: (tool: ResearchTool) => void;
  compact?: boolean;
}) {
  const body = (
    <ResearchHubBody question={question} onToolChosen={onToolChosen} />
  );

  if (!compact) {
    return body;
  }

  return (
    <details className="rounded-md border border-slate-200 bg-slate-50 p-4">
      <summary className="cursor-pointer text-sm font-medium text-slate-700">
        Recherche-Werkzeuge &amp; Prompt-Vorlage
      </summary>
      <div className="mt-3">{body}</div>
    </details>
  );
}
