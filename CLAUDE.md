# TrustMeBro — working notes for Claude

Prototype of a verification workshop for LLM-researched briefings, built for the thesis
"Großer Beleg". Next.js (App Router) + TypeScript strict, Node ≥ 20.9, **no database** —
the project file on disk is the only source of truth. See `ARCHITECTURE.md` for the full
layering and `README.md` for installation.

## The rule that surprises people: two languages, on purpose

**Code is English. The user-facing display tier is German — do not translate it.**

German by design (leave as-is):

- all UI copy in `app/**` (labels, buttons, headings, hints) and the _values_ of label maps
  such as `app/projects/status-labels.ts` — their _keys_ are the English enum values
- every message in `lib/pipeline/errors.ts` and other user-facing error prose
- persisted free-text `reason` strings in the register's history
- the generated `briefing.md` template (`lib/register/projection/render-briefing.ts`,
  which maps English enum values to German labels via `status-display.ts`)
- the instruction "must be written in German" inside `lib/adapters/prompts/**`
- `de-DE` locale / `Europe/Berlin` formatting

English everywhere else: identifiers, enum _values_ (`captured`, `confirmed`, `contested`,
`pending_adjudication`, …), actor tokens (`system:existence_check`, …), comments, docs.

## Gates

`npm run check` = lint → format → typecheck → tests with coverage thresholds. It must pass.
Use `npx vitest run <path>` while iterating; never watch mode in an agent session.

`tests/architecture.test.ts` is binding and deliberately duplicates rules ESLint also
enforces — never weaken it to make a change pass. It pins:

- `app/**` imports runtime code only from the `@/lib/pipeline` barrel (type-only imports exempt)
- the exact public surface of each `lib/*` barrel — a new public use-case must be added
  to the barrel _and_ to that list; internals stay internal
- network calls only through the `HttpFetcher` port implementations
- `process.env` only in `lib/identity`; filesystem writes only at sanctioned sites
- the claim status transition table, edge for edge

## Things that break silently if you forget

- `schema/claims.schema.json` is **generated** — run `npm run generate:schema`, never hand-edit.
- Prompt templates are versioned files (`lib/adapters/prompts/<kind>/v1.0.0.md`) and are
  **never edited in place** when behaviour changes; a changed prompt is a new version.
  `lib/pipeline/verification/rules/se-evidence-rubric-v1.json` pins the rubric prompt's
  SHA-256, so editing that prompt means updating the pin.
- The register is hash-chained and append-only. All writes go through
  `store.transaction(...)`; impure work (network, LLM) happens _before_ the transaction.
- Auto-import may only store a document it has proven is a real PDF. Never add a fallback
  to landing pages or abstracts — the frozen document is what stage-1 verification checks
  quoted wording against.

## Configuration

Copy `.env.example` to `.env`. Relevant variables: `TMB_ACTOR_HANDLE` (actor recorded in the
audit trail), `TMB_WORKSPACE` (project data root), `TMB_UNPAYWALL_EMAIL` (optional; enables
open-access PDF lookup — absent means that step is skipped), `TMB_PORT`, `TMB_NO_BROWSER`.
Installation-level config also lives in `~/.trustmebro/config.json` and is settable in the UI.

## The thesis is coupled to this code

The companion repo `trust-me-bro-thesis` holds the manuscript. Its appendix
_Entwurf des Projektdateiformats_ is **normative** for the register schema: field names and
enum values there must match `lib/register/schema/**`. An additive format change (new
optional field or project event) needs a short dated entry in that appendix's changelog
comment block, in German, following the existing entries. Implementation planning lives in
the Jira project `TMB`.
