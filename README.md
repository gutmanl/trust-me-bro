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

| Script              | Purpose                                       |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Start the web app in development mode         |
| `npm test`          | Run the domain-core test suite (Vitest)       |
| `npm run typecheck` | TypeScript strict check without emit          |
| `npm run lint`      | ESLint (includes architecture boundary rules) |
| `npm run format`    | Prettier over the repository                  |

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
