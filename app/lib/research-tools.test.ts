import { describe, expect, it } from "vitest";

import {
  assessResearchQuestion,
  buildResearchPrompt,
  RESEARCH_TOOLS,
} from "./research-tools";

const CLEAN_QUESTION =
  "Inwiefern reduziert der Einsatz von LLM-gestützten Code-Reviews die " +
  "Reviewzeit bei mittelgroßen Softwareprojekten im Vergleich zu " +
  "manuellen Reviews?";

describe("assessResearchQuestion", () => {
  it("returns no hints for a well-formed question", () => {
    expect(assessResearchQuestion(CLEAN_QUESTION)).toEqual([]);
  });

  it("warns when the question is very short", () => {
    expect(assessResearchQuestion("Testfrage?")).toEqual([
      {
        severity: "warnung",
        text: "Die Frage ist sehr kurz – sie sollte Kontext, Gegenstand und Zielgröße benennen.",
      },
    ]);
  });

  it("hints when the question has no question mark", () => {
    expect(
      assessResearchQuestion(
        "Wie wirkt sich KI-gestützte Automatisierung auf Softwarequalität aus",
      ),
    ).toEqual([
      {
        severity: "hinweis",
        text: "Als offene Frage formulieren (mit Fragezeichen) – Aufforderungen führen zu ausschweifenden Briefings.",
      },
    ]);
  });

  it("warns when the question joins several questions via 'und'", () => {
    expect(
      assessResearchQuestion(
        "Wie wirkt sich A auf B aus und wie beeinflusst B die C und wie hoch ist D?",
      ),
    ).toEqual([
      {
        severity: "warnung",
        text: "Das klingt nach mehreren Fragen. Ein Projekt prüft genau eine Frage – weitere Fragen als eigene Projekte anlegen (Atomarität, wie später bei den Claims).",
      },
    ]);
  });

  it("warns when the question contains several question marks", () => {
    const hints = assessResearchQuestion(
      "Was bedeutet das für die Softwarequalität? Und was folgt daraus für Teams?",
    );
    expect(hints).toContainEqual({
      severity: "warnung",
      text: "Das klingt nach mehreren Fragen. Ein Projekt prüft genau eine Frage – weitere Fragen als eigene Projekte anlegen (Atomarität, wie später bei den Claims).",
    });
  });

  it("hints when the question is a yes/no question", () => {
    for (const starter of [
      "Ist",
      "Sind",
      "Kann",
      "Können",
      "Hat",
      "Haben",
      "Wird",
      "Werden",
      "Sollte",
      "Sollten",
      "Gibt es",
      "Lohnt sich",
    ]) {
      const hints = assessResearchQuestion(
        `${starter} der Einsatz von KI in der Softwareentwicklung sinnvoll?`,
      );
      expect(hints, starter).toContainEqual({
        severity: "hinweis",
        text: "Ja/Nein-Fragen verleiten zu einseitigen Briefings – besser als W-Frage stellen (»Inwiefern …«, »Unter welchen Bedingungen …«).",
      });
    }
  });

  it("hints when a comparison word lacks a comparison target", () => {
    expect(
      assessResearchQuestion(
        "Welches Modell ist effizienter bei der Verarbeitung großer Datenmengen?",
      ),
    ).toEqual([
      {
        severity: "hinweis",
        text: "Ein Vergleichswort ohne Vergleichsmaßstab – benennen, womit verglichen wird (»… im Vergleich zu …«).",
      },
    ]);
  });

  it("does not hint on a comparison word when a comparison target ('als') is present", () => {
    const hints = assessResearchQuestion(
      "Welches Modell ist effizienter als das bisherige Verfahren bei der Verarbeitung großer Datenmengen?",
    );
    expect(hints).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("Vergleichswort") as unknown,
      }),
    );
  });
});

describe("RESEARCH_TOOLS", () => {
  it("lists exactly the seven expected tools", () => {
    expect(RESEARCH_TOOLS.map((tool) => tool.id)).toEqual([
      "elicit",
      "chatgpt",
      "gemini",
      "perplexity",
      "claude",
      "consensus",
      "agent_cli",
    ]);
  });
});

describe("buildResearchPrompt", () => {
  it("embeds the trimmed question verbatim", () => {
    const prompt = buildResearchPrompt(
      "  Wie wirkt sich Testkultur auf Codequalität aus?  ",
      "chatgpt",
    );
    expect(prompt).toContain("Wie wirkt sich Testkultur auf Codequalität aus?");
    expect(prompt).not.toContain("  Wie wirkt sich");
  });

  it("includes the shared core requirements", () => {
    const prompt = buildResearchPrompt(CLEAN_QUESTION, "claude");
    expect(prompt).toContain(
      "Recherchiere zu folgender Frage und schreibe ein Briefing auf Deutsch:",
    );
    expect(prompt).toContain(
      "Reiner Markdown-Fließtext mit einer kurzen Überschrift; keine Tabellen.",
    );
    expect(prompt).toContain(
      "Eine überprüfbare Aussage pro Absatz; Absätze durch Leerzeilen trennen.",
    );
    expect(prompt).toContain(
      "Bevorzuge begutachtete Publikationen und Preprints; kennzeichne graue",
    );
    expect(prompt).toContain(
      "Schließe mit einem Abschnitt »Quellen«: eine Zeile je Quelle mit DOI/arXiv-Id/URL.",
    );
  });

  it("prepends the tool-specific preamble", () => {
    const preambles: Record<string, string> = {
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
    for (const tool of RESEARCH_TOOLS) {
      const prompt = buildResearchPrompt(CLEAN_QUESTION, tool.id);
      expect(prompt.startsWith(preambles[tool.id] as string), tool.id).toBe(
        true,
      );
    }
  });
});
