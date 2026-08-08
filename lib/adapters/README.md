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

- `health/` — preflight diagnosis (TMB-49): per CLI three stages (on
  PATH, version compatible, login works), stages 1+2 free via one
  `--version` spawn, stage 3 an on-demand minimal real call with an
  in-process result cache.

## Fehlerklassen und Reaktionen (TMB-50)

The runtime error taxonomy (`core/errors.ts`) and its reactions, as
implemented by `core/retry.ts` (pure decision), the orchestrator (loop)
and the pipeline runs (persistence/escalation):

| `AdapterErrorKind` | Auslöser                                                                                      | Retry                                            | Eskalation                                                                                  | Lauf-Reaktion                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout`          | Kindprozess über `timeoutMs`, gekillt                                                         | begrenzt, exponentieller Backoff (`maxAttempts`) | nach Erschöpfung: Claim → `zur_adjudikation` (`routing: eskaliert`, Begründung im Verlauf)  | Lauf fährt mit dem nächsten Claim fort                                                                                                    |
| `process_failure`  | Exit ≠ 0, Spawn-Fehler, CLI-Fehlermeldung                                                     | wie `timeout`                                    | wie `timeout`                                                                               | wie `timeout`                                                                                                                             |
| `invalid_output`   | Ausgabe nicht parsebar (`AdapterOutputError`) oder schema-ungültig (`AdapterValidationError`) | wie `timeout`                                    | wie `timeout` — anhaltend schema-ungültige Ausgaben landen so begründet in der Adjudikation | wie `timeout`                                                                                                                             |
| `rate_limited`     | Rate-Limit-/Kontingentsignal der CLI (Muster in `backends/rate-limit-signal.ts`)              | **nie** (verbraucht kein Retry-Budget)           | **nie**                                                                                     | Lauf pausiert sichtbar: Klammer-Latch überspringt Restclaims ohne Register-Schreiben, Wiederaufnahme = neuer Lauf über die offenen Claims |

Invariants across all classes: the job runner persists per claim, so no
CLI error can corrupt the register or lose claims silently; a pause or
abort is a resumable state, never data loss. User-initiated pause/cancel
(TMB-50) is a separate, cooperative mechanism between items in
`lib/pipeline/runs/job-runner.ts` — it never interrupts an in-flight
attempt.

Manual real-CLI verification: `npx tsx scripts/adapter-smoke.ts
<claude|codex>` (spends subscription quota; CI never invokes real
CLIs).
