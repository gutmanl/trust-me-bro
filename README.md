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

## Getting started

```bash
cp .env.example .env   # set your kuerzel and workspace path
npm install
npm run dev
```

## Scripts

| Script                  | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `npm run dev`           | Start the web app in development mode             |
| `npm test`              | Run all test suites (unit, guard, E2E)            |
| `npm run test:coverage` | Tests with enforced coverage thresholds           |
| `npm run check`         | Everything CI runs: lint, format, types, coverage |
| `npm run typecheck`     | TypeScript strict check without emit              |
| `npm run lint`          | ESLint (includes architecture boundary rules)     |
| `npm run format`        | Prettier over the repository                      |

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
   chain/projection modules, raw writes outside the atomic-write
   helper, or any edit to the status transition table (which must be
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
app/            Next.js routes: pages + API (incl. SSE)
lib/register/   Domain core: schema, persistence, blob store, hash chain,
                status machine, briefing projection
lib/adapters/   Backend interface + agent-CLI adapters (later epic)
lib/pipeline/   Extraction and verification stages (later epic)
lib/export/     .tmb export bundle (later epic)
lib/identity/   Actor + workspace root (single-user; extension seam)
cli/            Standalone tools (tmb verify)
workspace/      Runtime data, one project directory per project (gitignored)
```

Two architecture rules are lint-enforced: `lib/` and `cli/` never import
from `app/`, and only `lib/identity` reads the environment.
