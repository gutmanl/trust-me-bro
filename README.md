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

## Installation and startup (evaluators, TMB-48)

Prerequisites:

- **Node.js ≥ 20.9** (LTS): <https://nodejs.org>
- **At least one logged-in agent CLI** with its own subscription:
  - Claude Code: `npm install -g @anthropic-ai/claude-code`, then run
    `claude` in the terminal and log in with `/login`.
  - Codex CLI: `npm install -g @openai/codex`, then `codex login`.
- The app starts without a CLI; import, sources, existence checking,
  adjudication, history and export stay usable — only the LLM
  verification steps are locked (the project's status page shows the
  three-stage diagnosis with concrete setup pointers).

TrustMeBro ships as an npm package, deliberately **without** publishing
to the public npm registry (`private: true` as a hard block);
installation runs from the packed tarball built out of this repository:

1. Build the tarball (once, in the repository):

   ```sh
   npm install
   npm pack
   ```

   This produces `trustmebro-0.1.0.tgz`; the `prepack` hook builds the
   standalone server (standalone output) along with it automatically.

2. Install and start (on the target system, any directory):

   ```sh
   npm install -g ./trustmebro-0.1.0.tgz
   trustmebro
   ```

   Alternatively, without a global install: `npx ./trustmebro-0.1.0.tgz`.

3. **First start:** the command starts the server on
   `http://127.0.0.1:4173` (loopback only, never visible on the LAN),
   opens the browser and redirects to the first-run setup at `/setup`.
   There, the actor handle is requested and stored in
   `~/.trustmebro/config.json`; the workspace lives under
   `~/.trustmebro/workspace`. A subsequent start detects the existing
   configuration and jumps straight to the project list.

Launcher environment variables: `TMB_PORT` (start port, default 4173;
occupied ports are skipped automatically), `TMB_NO_BROWSER=1` (do not
open a browser), `TMB_WORKSPACE` (alternate workspace root). All
further configuration variables: [.env.example](.env.example).

### Update

There is no registry for `npm update` to run against: build a new
tarball (`npm pack` in the updated repository) and run
`npm install -g ./trustmebro-<version>.tgz` again. The workspace and
configuration are untouched (they live outside the package).

### Smoke test (documented, Windows and macOS/Linux)

On a fresh system with Node and a logged-in Claude CLI, a single
command is enough to reach a usable interface:

**Windows (PowerShell):**

```powershell
npm install -g .\trustmebro-0.1.0.tgz
trustmebro
# browser opens /setup → enter handle → create project
# → project status page: stages 1+2 green, run "Anmeldung prüfen"
```

**macOS/Linux:**

```sh
npm install -g ./trustmebro-0.1.0.tgz
trustmebro
# identical flow; browser opens via open/xdg-open
```

Expected: the launcher reports `TrustMeBro läuft:
http://127.0.0.1:4173/`, `/setup` appears on first start, and after
setup the project page walks through briefing import → freeze sources →
extraction → verification. Stop with `Ctrl+C`.

## Getting started (development)

```bash
cp .env.example .env   # set your actor handle and workspace path
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
