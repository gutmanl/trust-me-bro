# lib/adapters

Backend interface and agent-CLI adapters (`claude -p`, `codex exec`),
output validation against the Evidence/Judgment sub-schemas, trace log.
Built in epic TMB-2 (Adapter-Schicht).

Layout (ports-and-adapters):

- `core/` — job model (four job kinds), the backend-agnostic `Backend`
  port and injectable ports, the adapter error taxonomy. Pure.
- `schema/` — adapter-owned zod result schemas per job kind;
  `AttributionOutput` derives from the register's `Judgment` sub-schema
  so the two cannot drift.
- `prompts/` — versioned prompt template files (`<kind>/v<version>.md`,
  never edited in place; a changed prompt is a new version) plus pure
  rendering. Templates are read from disk at runtime — if the app is
  ever built as standalone output, `lib/adapters/prompts/**` must be
  included in Next's file tracing.
- `backends/` — concrete backends. Each performs exactly one stateless
  attempt and throws typed `AdapterError`s; retry, tracing and
  concurrency live in the orchestrator.
- `orchestrator/` — the impure shell: retry loop (rate limits pause,
  everything else retries then escalates), output re-validation,
  provenance stamping, one trace envelope per attempt, plus the
  production wiring factory `createProjectOrchestrator`.
- `trace/` — JSON-RPC-like trace envelope schema. Traces are written as
  one immutable JSON file per adapter call to `<project>/traces/`
  (ratified TMB-20 decision) and travel with the export bundle; a
  successful attribution envelope's `finished_at` equals the merged
  judgment's `at` — the register↔trace correlation.
- `runtime/` — impure port implementations: child-process runner (the
  only spawn site), system clock, file trace sink (the single ratified
  deep import of the register's atomic-write helper), concurrency gate
  (global CLI cap, protects the subscription quota).

Manual real-CLI verification: `npx tsx scripts/adapter-smoke.ts
<claude|codex>` (spends subscription quota; CI never invokes real
CLIs).
