# lib/adapters

Backend interface and agent-CLI adapters (`claude -p`, `codex exec`),
output validation against the Evidence/Judgment sub-schemas, trace log.
Also home to the demonstration backend, which answers every job kind with
canned, schema-valid output and needs neither an installed CLI nor an
account.

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
  included in Next's file tracing. Documented exception: the
  German→English rename of the LLM output enum vocabulary (e.g.
  `einschlaegig`→`relevant`, `ja`/`nein`/`unsicher`→`yes`/`no`/`uncertain`)
  was applied in place without a version bump — it is a mechanical relabel
  of the output contract's literal values, not a behavioral prompt change.
- `backends/` — concrete backends. Each performs exactly one stateless
  attempt and throws typed `AdapterError`s; retry, tracing and
  concurrency live in the orchestrator.
- `orchestrator/` — the impure shell: retry loop (rate limits pause,
  everything else retries then escalates), output re-validation,
  provenance stamping, one trace envelope per attempt, plus the
  production wiring factory `createProjectOrchestrator`.
- `trace/` — JSON-RPC-like trace envelope schema. Traces are written as
  one immutable JSON file per adapter call to `<project>/traces/`
  and travel with the export bundle; a
  successful attribution envelope's `finished_at` equals the merged
  judgment's `at` — the register↔trace correlation.
- `runtime/` — impure port implementations: child-process runner (the
  only spawn site), system clock, file trace sink (the single ratified
  deep import of the register's atomic-write helper), concurrency gate
  (global CLI cap, protects the subscription quota).

- `health/` — preflight diagnosis: per CLI three stages (on
  PATH, version compatible, login works), stages 1+2 free via one
  `--version` spawn, stage 3 an on-demand minimal real call with an
  in-process result cache.

## Error classes and reactions

The runtime error taxonomy (`core/errors.ts`) and its reactions, as
implemented by `core/retry.ts` (pure decision), the orchestrator (loop)
and the pipeline runs (persistence/escalation):

| `AdapterErrorKind` | Trigger                                                                                 | Retry                                        | Escalation                                                                                    | Run reaction                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout`          | Child process killed after `timeoutMs`                                                  | limited, exponential backoff (`maxAttempts`) | after exhaustion: Claim → `pending_adjudication` (`routing: escalated`, reason in history)    | run continues with the next claim                                                                                                     |
| `process_failure`  | Exit ≠ 0, spawn error, CLI error message                                                | same as `timeout`                            | same as `timeout`                                                                             | same as `timeout`                                                                                                                     |
| `invalid_output`   | Output not parsable (`AdapterOutputError`) or schema-invalid (`AdapterValidationError`) | same as `timeout`                            | same as `timeout` — persistently schema-invalid outputs land in adjudication with that reason | same as `timeout`                                                                                                                     |
| `rate_limited`     | Rate-limit/quota signal from the CLI (pattern in `backends/rate-limit-signal.ts`)       | **never** (consumes no retry budget)         | **never**                                                                                     | run pauses visibly: the bracket latch skips the remaining claims without register writes, resumption = a new run over the open claims |

Invariants across all classes: the job runner persists per claim, so no
CLI error can corrupt the register or lose claims silently; a pause or
abort is a resumable state, never data loss. User-initiated pause/cancel
is a separate, cooperative mechanism between items in
`lib/pipeline/runs/job-runner.ts` — it never interrupts an in-flight
attempt.

Manual real-CLI verification: `npx tsx scripts/adapter-smoke.ts
<claude|codex>` (spends subscription quota; CI never invokes real
CLIs).
