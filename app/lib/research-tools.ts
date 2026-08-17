/**
 * Research acquisition hub (TMB-workbench-plan Task 12): a pure, client-safe
 * module with no dependency on lib/ — it is imported from the client-side
 * ResearchHub as well as from server pages, and the web-layer boundary rule
 * in tests/architecture.test.ts only allows runtime app/ imports of lib/
 * through the @/lib/pipeline barrel. Keeping this module free of any lib/
 * import sidesteps that rule entirely instead of needing an exemption.
 *
 * This tool guide and the deterministic prompt converter/question-quality
 * heuristics below replace the old static ResearchGuidance component.
 */

export type ResearchToolId =
  | "elicit"
  | "chatgpt"
  | "gemini"
  | "perplexity"
  | "claude"
  | "consensus"
  | "agent_cli";

export interface ResearchTool {
  id: ResearchToolId;
  /** display name */
  name: string;
  /** start URL */
  url: string;
  /** German: which mode/setting to select */
  mode: string;
  /** German: what it's good at */
  strengths: string;
  /** German: what to watch for */
  caveats: string;
}

export const RESEARCH_TOOLS: readonly ResearchTool[] = [
  {
    id: "elicit",
    name: "Elicit",
    url: "https://elicit.com",
    mode: "Im Eingabefeld den Modus »Research Agent« wählen (nicht die einfache Paper-Suche)",
    strengths:
      "Durchsucht wissenschaftliche Literatur und belegt Aussagen mit Paper-Zitaten samt DOI",
    caveats:
      "Auf englischsprachige Literatur ausgelegt – die Frage ggf. auf Englisch stellen, das Briefing anschließend auf Deutsch anfordern",
  },
  {
    id: "chatgpt",
    name: "ChatGPT (OpenAI)",
    url: "https://chatgpt.com",
    mode: "In der Eingabeleiste unter Werkzeugen »Deep Research« aktivieren",
    strengths:
      "Ausführliche Web-Recherche mit Quellenangaben, gut für Marktüberblicke und graue Literatur",
    caveats:
      "Zitiert auch Blogs und Anbieterseiten – im Prompt explizit DOI-belegte Literatur verlangen",
  },
  {
    id: "gemini",
    name: "Gemini (Google)",
    url: "https://gemini.google.com",
    mode: "Modell-/Werkzeugauswahl auf »Deep Research« stellen und den Rechercheplan bestätigen",
    strengths:
      "Breite Web-Recherche mit strukturiertem Bericht, Export nach Google Docs",
    caveats:
      "Quellenangaben teils ohne Identifikator – DOIs/arXiv-Ids explizit anfordern",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    url: "https://www.perplexity.ai",
    mode: "Suchmodus »Research« wählen; für Literatur den akademischen Fokus aktivieren",
    strengths: "Schnelle, quellenreiche Recherche mit direkter Zitatliste",
    caveats:
      "Kurze Berichte – die Anforderungen an Absatzstruktur und wörtliche Zitate im Prompt betonen",
  },
  {
    id: "claude",
    name: "Claude (Anthropic)",
    url: "https://claude.ai",
    mode: "Recherche-Funktion (»Research«) aktivieren, sofern im Tarif verfügbar",
    strengths:
      "Sorgfältige Quellenarbeit und gute Umsetzung von Formatvorgaben",
    caveats: "Verfügbarkeit der Recherche-Funktion hängt vom Tarif ab",
  },
  {
    id: "consensus",
    name: "Consensus",
    url: "https://consensus.app",
    mode: "Frage direkt stellen; Ergebnisansicht mit Papers und DOI-Angaben nutzen",
    strengths:
      "Belegfokus: aggregiert empirische Befunde aus begutachteten Studien",
    caveats:
      "Liefert Antworten je Einzelfrage statt eines Fließtext-Briefings – Ergebnisse selbst zu Absätzen zusammenführen",
  },
  {
    id: "agent_cli",
    name: "Agenten-CLI (Claude Code / Codex)",
    url: "",
    mode: "Im Terminal starten und den Prompt als Auftrag übergeben; Web-Zugriff des Agenten erlauben",
    strengths:
      "Frei steuerbar, Ergebnis landet als Datei direkt auf der eigenen Maschine",
    caveats:
      "Rechercheumfang selbst begrenzen (Zeit/Quellenzahl), sonst läuft der Agent lange",
  },
];

const TOOL_PREAMBLES: Record<ResearchToolId, string> = {
  elicit:
    "Nutze den Research-Agent-Modus. Beziehe dich ausschließlich auf wissenschaftliche Publikationen mit DOI.",
  chatgpt:
    "Führe eine Deep-Research-Recherche durch. Bevorzuge Publikationen mit DOI gegenüber Blogs und Anbieterseiten.",
  gemini:
    "Führe eine Deep-Research-Recherche durch und gib zu jeder Quelle einen eindeutigen Identifikator (DOI, arXiv-Id oder URL) an.",
  perplexity: "Nutze den Research-Modus mit akademischem Fokus.",
  claude: "Nutze die Recherche-Funktion mit Websuche.",
  consensus:
    "Beantworte die Frage anhand begutachteter Studien und gib zu jeder Studie die DOI an.",
  agent_cli:
    "Du bist ein Recherche-Agent mit Web-Zugriff. Lege das Ergebnis als briefing.md im Arbeitsverzeichnis ab.",
};

const CORE = (
  question: string,
) => `Recherchiere zu folgender Frage und schreibe ein Briefing auf Deutsch:

${question.trim()}

Anforderungen an das Briefing:
- Reiner Markdown-Fließtext mit einer kurzen Überschrift; keine Tabellen.
- Eine überprüfbare Aussage pro Absatz; Absätze durch Leerzeilen trennen.
- Jede Aussage, die auf einer Quelle beruht, nennt die Quelle direkt im Absatz
  – mit DOI, arXiv-Id oder vollständiger URL.
- Zitiere den belegenden Wortlaut wörtlich in Anführungszeichen und gib die
  Belegstelle an (Seite oder Abschnitt).
- Bevorzuge begutachtete Publikationen und Preprints; kennzeichne graue
  Literatur und Anbieterdokumentation als solche.
- Verwende nur öffentlich abrufbare Quellen. Erfinde keine Quellen und keine
  Belegstellen; fehlt ein Beleg, schreibe das ausdrücklich dazu.
- Schließe mit einem Abschnitt »Quellen«: eine Zeile je Quelle mit DOI/arXiv-Id/URL.`;

/** Deterministic converter: research question → ready-to-paste prompt for
 * the given tool (German prompt; core requirements shared, tool-specific
 * preamble). */
export function buildResearchPrompt(
  question: string,
  toolId: ResearchToolId,
): string {
  return `${TOOL_PREAMBLES[toolId]}\n\n${CORE(question)}`;
}

export interface QuestionHint {
  severity: "hinweis" | "warnung";
  text: string;
}

const YES_NO_STARTER =
  /^(ist|sind|kann|können|hat|haben|wird|werden|sollte|sollten|gibt es|lohnt sich)\b/i;

const COMPARISON_WORD =
  /\b(besser|schneller|effektiver|effizienter|sicherer)\b/i;

const COMPARISON_TARGET = /\bals\b/i;

/** Deterministic quality heuristics for research questions (German). */
export function assessResearchQuestion(question: string): QuestionHint[] {
  const trimmed = question.trim();
  const hints: QuestionHint[] = [];

  if (trimmed.length < 20) {
    hints.push({
      severity: "warnung",
      text: "Die Frage ist sehr kurz – sie sollte Kontext, Gegenstand und Zielgröße benennen.",
    });
  }

  if (!trimmed.includes("?")) {
    hints.push({
      severity: "hinweis",
      text: "Als offene Frage formulieren (mit Fragezeichen) – Aufforderungen führen zu ausschweifenden Briefings.",
    });
  }

  const undCount = trimmed.split(" und ").length - 1;
  const questionMarkCount = (trimmed.match(/\?/g) ?? []).length;
  if (undCount >= 2 || questionMarkCount >= 2) {
    hints.push({
      severity: "warnung",
      text: "Das klingt nach mehreren Fragen. Ein Projekt prüft genau eine Frage – weitere Fragen als eigene Projekte anlegen (Atomarität, wie später bei den Aussagen).",
    });
  }

  if (YES_NO_STARTER.test(trimmed)) {
    hints.push({
      severity: "hinweis",
      text: "Ja/Nein-Fragen verleiten zu einseitigen Briefings – besser als W-Frage stellen (»Inwiefern …«, »Unter welchen Bedingungen …«).",
    });
  }

  if (COMPARISON_WORD.test(trimmed) && !COMPARISON_TARGET.test(trimmed)) {
    hints.push({
      severity: "hinweis",
      text: "Ein Vergleichswort ohne Vergleichsmaßstab – benennen, womit verglichen wird (»… im Vergleich zu …«).",
    });
  }

  return hints;
}
