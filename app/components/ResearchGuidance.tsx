"use client";

import { useState } from "react";

/**
 * Research guidance (TMB-54, D12). The tool verifies a briefing that was
 * researched somewhere else, and until now nothing in the interface said
 * so — someone arriving without a briefing simply dead-ended. Collapsed by
 * default on purpose: it is a hint, and it must not push the actual import
 * control below the fold.
 *
 * Producing the briefing inside the application is a separate feature and
 * deliberately not implied here.
 */

const PROMPT_TEMPLATE = `Recherchiere zu folgender Frage und schreibe ein Briefing:

<RECHERCHEFRAGE>

Anforderungen an das Briefing:
- Reiner Markdown-Fließtext, keine Tabellen, keine Aufzählungen.
- Eine überprüfbare Aussage pro Absatz. Absätze durch Leerzeilen trennen.
- Jede Aussage, die auf einer Quelle beruht, nennt diese Quelle direkt im
  Absatz — mit DOI, arXiv-Id oder vollständiger URL.
- Zitiere den belegenden Wortlaut aus der Quelle wörtlich, in
  Anführungszeichen, und gib die Fundstelle an (Seite oder Abschnitt).
- Verwende nur Quellen, die öffentlich abrufbar sind.
- Erfinde keine Quellen und keine Fundstellen. Wenn du für eine Aussage
  keinen Beleg hast, schreibe das ausdrücklich dazu.`;

export function ResearchGuidance({
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <details
      open={defaultOpen}
      className="rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <summary className="cursor-pointer text-sm font-medium text-slate-700">
        Woher kommt das Briefing? (Kurzanleitung zur Recherche)
      </summary>
      <div className="mt-3 space-y-3 text-sm text-slate-600">
        <p>
          Diese Anwendung <strong>prüft</strong> ein Briefing, sie erstellt es
          nicht. Die Recherche findet außerhalb statt – in einer Agenten-CLI
          (z.&nbsp;B. Claude Code oder Codex) oder in einem Chat-Assistenten.
          Das Ergebnis wird hier importiert, eingefroren und anschließend gegen
          seine Quellen geprüft.
        </p>
        <p>Damit die Prüfung greifen kann, sollte das Briefing:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>seine Quellen nennen</strong> – die erste Prüfstufe
            vergleicht den zitierten Wortlaut mit dem eingefrorenen Dokument;
            ohne Quelle gibt es nichts zu vergleichen;
          </li>
          <li>
            <strong>eine Aussage je Absatz</strong> enthalten, als schlichter
            Markdown-Fließtext – so lässt es sich am zuverlässigsten in einzelne
            Claims zerlegen;
          </li>
          <li>
            <strong>öffentlich abrufbare Quellen</strong> verwenden (DOI,
            arXiv-Id oder URL), damit der automatische Import die Dokumente
            einfrieren kann.
          </li>
        </ul>
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium text-slate-700">
              Vorlage für die Recherche-Anfrage
            </p>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(PROMPT_TEMPLATE)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-500"
            >
              {copied ? "Kopiert" : "In die Zwischenablage kopieren"}
            </button>
          </div>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-slate-200 bg-white p-3 font-mono text-xs whitespace-pre-wrap text-slate-700">
            {PROMPT_TEMPLATE}
          </pre>
          <p className="mt-1 text-xs text-slate-500">
            <code className="font-mono">&lt;RECHERCHEFRAGE&gt;</code> durch die
            eigene Frage ersetzen.
          </p>
        </div>
      </div>
    </details>
  );
}
