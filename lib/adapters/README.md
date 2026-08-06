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
  concurrency live in the orchestrator (later tickets of this epic).
