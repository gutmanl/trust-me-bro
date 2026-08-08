# TrustMeBro

Prototype of a verification workshop for researched briefings: it binds
every claim of an imported briefing to verifiable evidence in a frozen
source corpus, routes doubtful claims to human adjudication, and keeps a
tamper-evident, append-only history. Developed as part of the thesis
"Großer Beleg" (see the thesis appendices _Entwurf des
Projektdateiformats_ and _Grobentwurf_ for the normative design;
implementation planning lives in the Jira project `TMB`).

## Stack

Next.js (App Router) + TypeScript strict, Node.js. No database — the
project file format on disk is the only source of truth.

## Installation und Start (Evaluatoren, TMB-48)

Voraussetzungen:

- **Node.js ≥ 20.9** (LTS): <https://nodejs.org>
- **Mindestens eine angemeldete Agenten-CLI** mit eigener Subskription:
  - Claude Code: `npm install -g @anthropic-ai/claude-code`, dann im
    Terminal `claude` starten und mit `/login` anmelden.
  - Codex CLI: `npm install -g @openai/codex`, dann `codex login`.
- Ohne CLI ist die App startbar; Import, Quellen, Existenzprüfung,
  Adjudikation, Verlauf und Export bleiben nutzbar — nur die
  LLM-Prüfschritte sind gesperrt (die Statusseite im Projekt zeigt die
  dreistufige Diagnose mit konkreten Einrichtungshinweisen).

TrustMeBro wird als npm-Paket verteilt, bewusst **ohne**
Veröffentlichung im öffentlichen npm-Register (`private: true` als
harte Sperre); die Installation läuft über das gepackte Tarball aus
diesem Repository:

1. Tarball bauen (einmalig, im Repository):

   ```sh
   npm install
   npm pack
   ```

   Das erzeugt `trustmebro-0.1.0.tgz`; der `prepack`-Hook baut den
   eigenständigen Server (standalone output) automatisch mit.

2. Installieren und starten (auf dem Zielsystem, beliebiges Verzeichnis):

   ```sh
   npm install -g ./trustmebro-0.1.0.tgz
   trustmebro
   ```

   Alternativ ohne globale Installation: `npx ./trustmebro-0.1.0.tgz`.

3. **Erster Start:** Der Befehl startet den Server auf
   `http://127.0.0.1:4173` (nur Loopback, nie im LAN sichtbar), öffnet
   den Browser und leitet auf die Ersteinrichtung `/setup`. Dort wird
   das Akteurskürzel abgefragt und in `~/.trustmebro/config.json`
   gespeichert; der Workspace liegt unter `~/.trustmebro/workspace`.
   Ein erneuter Start erkennt die bestehende Konfiguration und springt
   direkt zur Projektliste.

Umgebungsvariablen des Launchers: `TMB_PORT` (Startport, Standard
4173; belegte Ports werden automatisch übersprungen),
`TMB_NO_BROWSER=1` (keinen Browser öffnen), `TMB_WORKSPACE`
(abweichende Workspace-Wurzel). Alle weiteren Konfigurationsvariablen:
[.env.example](.env.example).

### Update

Es gibt kein Register, gegen das `npm update` laufen könnte: neues
Tarball bauen (`npm pack` im aktualisierten Repository) und erneut
`npm install -g ./trustmebro-<version>.tgz` ausführen. Workspace und
Konfiguration bleiben unberührt (sie liegen außerhalb des Pakets).

### Smoke-Test (dokumentiert, Windows und macOS/Linux)

Auf einem frischen System mit Node und angemeldeter Claude-CLI genügt
ein Befehl bis zur nutzbaren Oberfläche:

**Windows (PowerShell):**

```powershell
npm install -g .\trustmebro-0.1.0.tgz
trustmebro
# Browser öffnet /setup → Kürzel eingeben → Projekt anlegen
# → Statusseite des Projekts: Stufen 1+2 grün, „Anmeldung prüfen" ausführen
```

**macOS/Linux:**

```sh
npm install -g ./trustmebro-0.1.0.tgz
trustmebro
# identischer Ablauf; Browseröffnung via open/xdg-open
```

Erwartung: Der Launcher meldet `TrustMeBro läuft:
http://127.0.0.1:4173/`, `/setup` erscheint beim ersten Start, nach der
Einrichtung führt die Projektseite durch Briefing-Import → Quellen
einfrieren → Extraktion → Prüfung. Beenden mit `Strg+C`.

## Getting started (development)

```bash
cp .env.example .env   # set your kuerzel and workspace path
npm install
npm run dev
```

## Scripts

| Script                                    | Purpose                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| `npm run dev`                             | Start the web app in development mode                 |
| `npm test`                                | Run all test suites (unit, guard, E2E)                |
| `npm run test:coverage`                   | Tests with enforced coverage thresholds               |
| `npm run check`                           | Everything CI runs: lint, format, types, coverage     |
| `npm run typecheck`                       | TypeScript strict check without emit                  |
| `npm run lint`                            | ESLint (includes architecture boundary rules)         |
| `npm run format`                          | Prettier over the repository                          |
| `npm run package:build`                   | Standalone build + asset staging (TMB-48)             |
| `npm pack`                                | Distribution tarball (runs package:build via prepack) |
| `npm run tmb -- verify <dir\|bundle.tmb>` | Standalone integrity check                            |

## Testing

The suite has four layers, and all of them run in CI (Ubuntu **and**
Windows, since the register's rename/lock semantics are OS-sensitive):

1. **Unit tests** next to each module (`lib/**/*.test.ts`) — schema
   validation, RFC 8785 vectors, chain tampering, gates, projection
   golden file.
2. **Architecture guards** (`tests/architecture.test.ts`) — fail when a
   change erodes a structural invariant: the public barrel leaking the
   chain minter or raw engine, `app/` imports in the domain core,
   `process.env` outside `lib/identity`, filesystem access in the pure
   chain/projection modules, raw writes outside the sanctioned write
   sites, or any edit to the status transition table (which must be
   changed consciously in code _and_ test).
3. **End-to-end** (`tests/e2e/lifecycle.e2e.test.ts`) — one project
   walked from creation through freezing, all verification stages,
   sampling, adjudication and repair to the rendered `briefing.md`,
   validated against the committed JSON Schema and verified by the
   real `tmb verify` CLI as a separate OS process (including a
   tamper-detection case).
4. **Cross-process concurrency**
   (`tests/e2e/multiprocess.e2e.test.ts`) — three OS processes write
   the same project concurrently; the chain must come out gapless.

Coverage thresholds (`vitest.config.ts`) are a ratchet: raise them
when coverage grows, never lower them to make a change pass.

## Structure

```
app/            Next.js routes: pages + API (incl. SSE), /setup first run
lib/register/   Domain core: schema, persistence, blob store, hash chain,
                status machine, briefing projection
lib/adapters/   Backend interface + agent-CLI adapters, preflight health,
                API-backend spike (feature-flagged)
lib/pipeline/   Extraction/verification/relevance runs, run control,
                adjudication, export, setup use-cases
lib/export/     .tmb export bundle
lib/identity/   Actor + workspace root + stored first-run config
                (single-user; extension seam)
cli/            Standalone tools (tmb verify)
bin/            npx launcher for the packaged standalone server
proxy.ts        First-run gate: redirects to /setup until configured
workspace/      Runtime data, one project directory per project (gitignored)
```

Two architecture rules are lint-enforced: `lib/` and `cli/` never import
from `app/`, and only `lib/identity` reads the environment. The full
seam documentation (multi-user extension path, ToS rationale) lives in
[ARCHITECTURE.md](ARCHITECTURE.md); the CLI error-class/reaction table
in [lib/adapters/README.md](lib/adapters/README.md).
