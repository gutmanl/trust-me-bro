# TrustMeBro

A verification workshop for researched briefings.

You bring a briefing — a piece of research writing that cites sources.
TrustMeBro breaks it into individual claims, binds each claim to the wording
that is supposed to support it, and freezes the cited documents so that
wording can be checked against something that cannot change afterwards.
Claims that do not hold up are routed to you for a decision. Every step,
including your decisions, is recorded in an append-only, hash-chained
history that anyone can re-verify later without the application.

It is built for the case where the briefing came out of an LLM: the dominant
failure mode there is a source that does not say what it is claimed to say,
or does not exist at all. The first verification stage is deterministic and
model-independent for exactly that reason — it compares quoted wording
against the frozen document, byte by byte.

## What it does

- **Import and freeze.** A briefing is stored verbatim and hashed. Its
  sources are fetched and frozen as documents, so later verification always
  refers to the same bytes.
- **Extract claims.** The briefing is split into individual, checkable
  statements, each anchored to the paragraph it came from.
- **Verify in three stages.** Stage 1 checks the quoted wording against the
  frozen document — deterministic, no model involved. Stages 2 and 3 ask a
  model whether the evidence actually supports the claim and whether it
  meets the configured evidence rubric.
- **Adjudicate.** Anything doubtful goes to a queue for a human decision,
  along with a spot-check sample of what was auto-confirmed. Contested
  claims can be repaired and re-checked, or discarded with a reason.
- **Export and re-verify.** A project exports as a self-contained `.tmb`
  bundle. The bundled `tmb verify` command re-runs the hash chain, the
  manifest and the blob integrity check independently of this application.

There is no database. A project is a directory on disk, and that directory
is the only source of truth.

## Requirements

- **Node.js 20.9 or newer** (LTS): <https://nodejs.org>
- **Optionally, a logged-in agent CLI** for the model-backed steps:
  - Claude Code: `npm install -g @anthropic-ai/claude-code`, then run
    `claude` and log in with `/login`.
  - Codex CLI: `npm install -g @openai/codex`, then `codex login`.

The application runs without any CLI installed. Import, sources, stage-1
existence checking, adjudication, history and export all stay usable; only
the model-backed verification stages are locked, and the setup wizard and
the settings page show a three-stage diagnosis per backend with concrete
pointers for what is missing.

If you want to see the whole workflow before installing anything, choose the
**demonstration backend** during setup. It produces canned results without a
CLI and without an account. Its results are not verification, and everything
produced with it is labelled as a demo — in the interface, and permanently
in the hash chain, so a demo bundle still identifies itself as one after
export.

## Installation

TrustMeBro is distributed as a packed npm tarball rather than through the
public registry. Build it once from a checkout:

```sh
npm install
npm pack
```

That produces `trustmebro-<version>.tgz`; the `prepack` hook builds the
server and the `tmb` command with it.

Then, on the target machine, in any directory:

```sh
npm install -g ./trustmebro-0.1.0.tgz
trustmebro
```

Or without a global install: `npx ./trustmebro-0.1.0.tgz`.

### First start

`trustmebro` starts the server on `http://127.0.0.1:4173`, bound to
loopback only and never visible on the network, then opens a browser at the
setup wizard.

The wizard asks for five things, and only the first is required:

1. **Your handle** — a short identifier recorded as
   `human:<handle>` in every history entry you cause.
2. **The workspace directory** — where project directories are stored.
   Settable now only: moving it later would leave existing projects behind,
   and nothing migrates them.
3. **Backend diagnosis** — which agent CLIs were found and whether they are
   usable, including an optional live login probe.
4. **An Unpaywall address** (optional) — enables looking up open-access
   copies of sources. Without it that lookup is skipped.
5. **Getting started** — create your first project, or create the example
   project to walk through a filled-in register first.

The configuration is stored in `~/.trustmebro/config.json`, the workspace
under `~/.trustmebro/workspace`. Later starts skip the wizard and go
straight to the project list. Installation-wide settings, including a
change of handle, stay reachable at **Einstellungen** in the header.

### Updating

Build a new tarball from the updated checkout and install it again:

```sh
npm pack
npm install -g ./trustmebro-<version>.tgz
```

Your workspace and configuration live outside the package and are untouched.

## Verifying a project independently

Installing the package also installs `tmb`, which re-checks a project
directory or an exported bundle without starting the application:

```sh
tmb verify ~/.trustmebro/workspace/proj_beispiel
tmb verify ./projekt-export.tmb
```

It re-runs the hash chain, confirms the content matches the state root
committed by the last entry, and checks every stored document against its
recorded checksum. It exits `0` when everything holds and `1` when it does
not, so it fits into a script or a CI step. This is the check a recipient of
a bundle can run without trusting — or installing — the application that
produced it.

## Environment variables

The launcher reads `TMB_PORT` (start port, default 4173; occupied ports are
skipped), `TMB_NO_BROWSER=1` (do not open a browser) and `TMB_WORKSPACE`
(alternate workspace root). Anything set in the environment takes precedence
over the stored configuration and is shown as read-only in the interface.
All variables are documented in [.env.example](.env.example).

## Development

```sh
cp .env.example .env
npm install
npm run dev
```

| Script                                    | Purpose                                           |
| ----------------------------------------- | ------------------------------------------------- |
| `npm run dev`                             | Start the web app in development mode             |
| `npm test`                                | Run all test suites (unit, guard, E2E)            |
| `npm run test:coverage`                   | Tests with enforced coverage thresholds           |
| `npm run check`                           | Everything CI runs: lint, format, types, coverage |
| `npm run typecheck`                       | TypeScript strict check without emit              |
| `npm run lint`                            | ESLint, including the architecture boundary rules |
| `npm run format`                          | Prettier over the repository                      |
| `npm run build:cli`                       | Compile the `tmb` CLI to `dist/`                  |
| `npm run package:build`                   | Standalone build and asset staging                |
| `npm pack`                                | Distribution tarball (runs package:build)         |
| `npm run tmb -- verify <dir\|bundle.tmb>` | Run the integrity check from a checkout           |
| `npm run test:browser`                    | Playwright browser end-to-end suite               |
| `npm run corpus:seed`                     | Regenerate the synthetic corpus cassettes         |
| `npm run corpus:record`                   | Record the corpus from the live services          |
| `npm run corpus:fetch`                    | Download the hash-pinned corpus documents         |

### Testing

Six layers. The first four run in CI on Ubuntu **and** Windows, because the
register's rename and locking semantics are OS-sensitive; the browser layer
runs on Ubuntu only, as a separate job:

1. **Unit tests** beside each module (`lib/**/*.test.ts`) — schema
   validation, RFC 8785 vectors, chain tampering, gates, the projection
   golden file.
2. **Architecture guards** (`tests/architecture.test.ts`) — these fail when
   a change erodes a structural invariant: a public barrel leaking the chain
   minter or the raw engine, `app/` imports in the domain core,
   `process.env` outside `lib/identity`, filesystem access in the pure
   chain and projection modules, raw writes outside the sanctioned write
   sites, or any edit to the status transition table, which has to be
   changed deliberately in both code and test.
3. **End-to-end** (`tests/e2e/lifecycle.e2e.test.ts`) — one project walked
   from creation through freezing, every verification stage, sampling,
   adjudication and repair to the rendered `briefing.md`, validated against
   the committed JSON Schema and verified by the real `tmb verify` binary
   as a separate OS process, including a tamper-detection case.
4. **Cross-process concurrency** (`tests/e2e/multiprocess.e2e.test.ts`) —
   three OS processes write the same project at once; the chain has to come
   out gapless.
5. **Corpus-driven end-to-end** (`tests/e2e/corpus-*.e2e.test.ts`) — the real
   pipeline use-cases, one spec per failure class, driven by recorded
   responses from doi.org, arXiv, Crossref and Unpaywall and by recorded LLM
   answers. The record-and-replay corpus lives in `tests/corpus/`; see its
   README for how to record it and what it exposed. A cassette miss fails
   loudly rather than falling through to the network.
6. **Browser** (`tests/browser/*.spec.ts`, `npm run test:browser`) — Playwright
   over the real app on desktop and mobile viewports: the workbench, the
   adjudication decision landing in the append-only register, the complaint
   dialog, bundle download, and a hydration check that catches a page which
   server-renders but never becomes interactive. The workspace is seeded out
   of band from the same corpus, so the claims under review are open for real
   reasons.

The corpus also carries the thesis's own literature-search output — 675 real
identifiers from two agentic research systems, the frozen corpus manifest and
the archived exclusion log — which `tests/corpus/identifier-corpus.test.ts`
runs the identifier parsing against.

Coverage thresholds in `vitest.config.ts` are a ratchet: raise them as
coverage grows, never lower them to make a change pass.

## Structure

```
app/            Next.js routes: pages + API (incl. SSE), setup wizard, settings
lib/register/   Domain core: schema, persistence, blob store, hash chain,
                status machine, briefing projection
lib/adapters/   Backend interface + agent-CLI adapters, preflight health,
                demonstration backend
lib/pipeline/   Extraction/verification/relevance runs, run control,
                adjudication, export, setup use-cases
lib/export/     .tmb export bundle
lib/identity/   Actor + workspace root + stored configuration
                (single-user; extension seam)
cli/            The tmb command (verify)
bin/            Launcher for the packaged standalone server
proxy.ts        First-run gate: redirects to /setup until configured
workspace/      Runtime data, one directory per project (gitignored)
```

Two architecture rules are lint-enforced: `lib/` and `cli/` never import
from `app/`, and only `lib/identity` reads the environment. The full seam
documentation lives in [ARCHITECTURE.md](ARCHITECTURE.md); the CLI
error-class and reaction table in
[lib/adapters/README.md](lib/adapters/README.md).
