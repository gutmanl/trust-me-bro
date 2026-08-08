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

## Erweiterungspfad Mehrbenutzer-Betrieb

Wird mit TMB-51 vollständig dokumentiert (vier Nahtstellen: Backend-
Interface, Identität, Workspace-Abstraktion, globale CLI-Warteschlange —
samt nutzungsrechtlicher Begründung des Single-User-Zuschnitts). Für die
Identitäts-Nahtstelle gilt bereits: Eine Mehrbenutzer-Architektur ersetzt
allein die Auflösung in `loadIdentityConfig` (z. B. sitzungsgebunden statt
dateigebunden); sämtliche Aufrufer von `getCurrentActor()` /
`getWorkspaceRoot()` behalten ihre Signaturen.
