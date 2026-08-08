# TrustMeBro — Architektur

Normative Grundlage sind die Thesis-Anhänge „Entwurf des Projektdateiformats"
und „Grobentwurf"; dieses Dokument hält die im Repo umgesetzten Nahtstellen
fest. Die Strukturregeln werden nicht nur beschrieben, sondern durch
`tests/architecture.test.ts` erzwungen.

## Schichten

```
lib/identity/   Fundament: einziger Leser von process.env und der
                gespeicherten Erstkonfiguration; beantwortet „aktueller
                Akteur" und „aktuelle Workspace-Wurzel".
lib/register/   Domänenkern: claims.json, Hash-Kette, Statusmaschine,
                Blob-Store. Hängt nur von lib/identity ab.
lib/export/     Bundle-Kern (.tmb): neben dem Register nutzbar, ohne
                Pipeline- oder Adapter-Abhängigkeit (CLI-tauglich).
lib/adapters/   Backend-Interface und Adapter (Claude-CLI, Codex-CLI),
                Orchestrator (Retry/Trace/Concurrency), Laufzeit-Ports
                (Prozess-Runner, Trace-Sink, Concurrency-Gate).
lib/pipeline/   Use-Cases, die die Weboberfläche aufruft; Job-Runner.
app/            Next.js-Oberfläche; importiert ausschließlich das
                öffentliche Pipeline-Barrel.
cli/            Eigenständiges Prüfwerkzeug (tmb verify), nur auf
                Register- und Export-Barrel.
proxy.ts        Erstlauf-Gate: leitet bis zur abgeschlossenen Einrichtung
                jede Anfrage auf /setup um (Next 16 Proxy, Node-Runtime).
```

## Identität und Workspace (TMB-47)

`lib/identity` ist die einzige Stelle, die beantwortet, **wer** handelt und
**wo** Projekte liegen:

- `getCurrentActor(): "human:<kuerzel>"` — Akteurskennung aller
  Verlaufseinträge.
- `getWorkspaceRoot(): string` — absolute Workspace-Wurzel.
- `resolveProjectDir(projectId): string` — einzige Pfadkonstruktion für
  Projektverzeichnisse (validiert die Projekt-Id, schließt Traversal aus).

Konfigurationsauflösung **je Feld**: Umgebungsvariable →
gespeicherte Konfigurationsdatei → Code-Default. Das Akteurskürzel hat
bewusst **keinen** Code-Default: Ist es nirgends konfiguriert, wirft
`loadIdentityConfig()` `IdentityNotConfiguredError`, und `proxy.ts` leitet
auf die Ersteinrichtung `/setup` um. Die Datei liegt außerhalb des
Workspace (Standard `~/.trustmebro/config.json`, Override
`TMB_CONFIG_PATH`), weil die Workspace-Lage selbst eine ihrer Antworten
ist. Geschrieben wird sie ausschließlich über
`writeIdentityConfig` (atomar, zweite sanktionierte Roh-Schreibstelle
neben dem Atomic-Write-Helfer des Registers — `lib/register` hängt von
`lib/identity` ab, der umgekehrte Import wäre eine Schichtumkehr).

Erzwungen durch Architektur-Tests: `process.env` nur in `lib/identity`;
`getWorkspaceRoot`/`resolveProjectDir` nur an den festgeschriebenen
Aufrufstellen (Register-Store, Projektliste, Bundle-Import, Setup).

## Betriebsrobustheit (TMB-49/50)

- **Preflight** (`lib/adapters/health/`): je Backend drei Prüfstufen — CLI
  im Suchpfad, Version kompatibel, Anmeldung funktionsfähig. Stufen 1+2
  sind kostenlos (ein `--version`-Spawn über den sanktionierten Runner)
  und laufen bei jedem Seitenaufbau und Laufstart; Stufe 3 ist ein
  bewusst manueller Testaufruf (kostet Kontingent) mit In-Process-Cache.
  Extraktion und Einschlägigkeitsprüfung verweigern den Start gegen ein
  nicht einsatzbereites primäres Backend; die Prüfkaskade läuft weiter
  (Stufe 1 bleibt nutzbar) und überspringt nur die LLM-Stufen je Claim.
- **Laufzeitfehler**: Fehlerklassen und Reaktionen sind in
  `lib/adapters/README.md` („Fehlerklassen und Reaktionen") tabelliert.
  Nutzerinitiiertes Pausieren/Abbrechen ist ein kooperatives Primitiv des
  Job-Runners (zwischen Items, nie mitten in einem CLI-Aufruf); da je
  Claim persistiert wird, ist jeder Abbruch ein wiederaufnehmbarer
  Zustand.

## Erweiterungspfad Mehrbenutzer-Betrieb (TMB-51)

Der Prototyp ist konsequent single-user. Die spätere
Mehrbenutzer-Architektur ist ein dokumentierter Erweiterungspfad über
vier Nahtstellen — entworfen, punktuell belegt, nicht gebaut:

1. **Backend-Interface** (`lib/adapters/core/contracts.ts`, `Backend`):
   bewusst frei von CLI-Vokabular. Der TMB-51-Spike
   (`createAnthropicApiBackend`, Anthropic Messages API hinter einem
   eigenen HTTP-Port analog zum Prozess-Runner) ist der Existenzbeweis:
   ein API-Backend ist ein weiterer Adapter und besteht denselben
   Vertragstest (`lib/adapters/__fixtures__/contract-suite.ts`) wie die
   CLI-Adapter — ohne Änderung an Pipeline oder Register. Der Spike ist
   doppelt verriegelt (`TMB_ENABLE_API_BACKEND=1` + `ANTHROPIC_API_KEY`)
   und implementiert nur den Auftragstyp Attributionsurteil; ohne
   Schlüssel läuft der Prototyp unverändert.
2. **Identität** (`lib/identity`): siehe oben — eine Anmeldung ersetzt
   allein die Auflösung in `loadIdentityConfig` (sitzungs- statt
   dateigebunden); alle Aufrufer behalten ihre Signaturen.
3. **Workspace-Abstraktion** (`resolveProjectDir`): heute eine flache
   Wurzel; Mehrbenutzer-Betrieb bedeutet eine Wurzel je Benutzer in
   genau dieser einen Funktion — der Architektur-Test garantiert, dass
   sie die einzige Pfadautorität ist.
4. **Globale CLI-Warteschlange** (`getGlobalConcurrencyGate`): heute ein
   prozessweiter Semaphor, der das Kontingent der einen Subskription
   schützt; Mehrbenutzer-Betrieb ersetzt den Singleton durch eine je
   Mandant bemessene Kapazität hinter demselben `ConcurrencyGate`-Port.

**Nutzungsrechtliche Begründung des Single-User-Zuschnitts:** Die
Standard-Backends sind Agenten-CLIs mit Subskriptionsanmeldung; deren
Nutzungsbedingungen binden die Kontingente an die persönliche Nutzung
des Kontoinhabers. Ein Server, der CLI-Aufrufe stellvertretend für
mehrere Benutzer ausführt, betriebe die Subskription als geteilten
Dienst und verließe den zulässigen Rahmen. Ein regelkonformer
Mehrbenutzer-Betrieb führt nur über tokenbasiert abgerechnete
API-Anbindungen — genau der Pfad, den Nahtstelle 1 mit dem Spike
offenhält. Zusätzlich wären Anmeldung und Mandantentrennung (Nahtstelle
2/3) sowie Zugriffskontrolle und Prozess-Isolation nötig; beides ist
entworfen, aber bewusst nicht Teil des Prototyps.
