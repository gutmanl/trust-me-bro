# Code quality review

Review date: 2026-08-13
Scope: maintainability-focused code quality of `lib/**`, `app/**`, `cli/**`, `scripts/**`, and the test suite — the perspective of an academic reviewer grading structural quality. Security and audit-integrity topics were covered separately by `SOFTWARE_REVIEW.md` (2026-08-08) and are not repeated here.

## Overall assessment

The codebase is unusually disciplined for a research prototype. Production code contains no `any` leaks, no `@ts-ignore`/`@ts-expect-error`/`eslint-disable`, no TODO/FIXME markers, and no swallowed catch blocks; catches that discard errors are documented best-effort fallbacks. The layering described in `ARCHITECTURE.md` is real and mechanically enforced by `tests/architecture.test.ts` (barrel surfaces, `process.env`/filesystem/network/child-process confinement, the full claim-status transition table), coverage thresholds are ratcheted, and the sampled tests are behavioral rather than mock-echoes.

The findings below are the quality issues that remained. Q-01 through Q-07 were addressed in the refactor accompanying this review; Q-08 through Q-10 are known, deliberate trade-offs that were documented rather than changed.

## Findings addressed by the accompanying refactor

### Q-01 - Duplicated event-append boilerplate in the register transaction factory

`lib/register/persistence/store.ts` (932 lines, the largest source file) repeated the same three-step pattern — `chain.append({...}) as ProjectEvent`, push onto `draft.project_events`, return the entry — nine times across the transaction capabilities. Resolution: a single `appendProjectEvent` helper is now the one place a chained project event is minted. The `as ProjectEvent` casts turned out to be structurally unnecessary (the appender's return type plus `ChainLink` _is_ a `ProjectEvent`), so the refactor removed every such cast in the file, including the two outside the factory.

### Q-02 - Four hand-rolled copies of the run-bracket derivation

`lib/pipeline/verification/derive-state.ts`, `lib/pipeline/warm/derive-state.ts`, `lib/pipeline/research/derive-state.ts`, and `lib/pipeline/sources/reference-scan/derive-state.ts` each reimplemented the identical algorithm: find the last `*_started`/`*_completed` events, compare `seq`, derive running/interrupted/closed/not-started (one file's comment admitted "mirroring extraction/derive-state.ts"). A bug fix or a new phase semantic had to be propagated by hand to four files. Resolution: the shared core now lives in `lib/pipeline/runs/derive-bracket.ts` as `deriveRunBracket`, whose discriminated-union result encodes the invariants (`interrupted` always has a start, `closed` always has a completion); each domain keeps only its own status overlay (halted vs. completed, failed vs. completed, …). Covered by a dedicated unit test plus the four callers' existing tests.

### Q-03 - Sextuplicated preflight-resolution idiom

The expression `deps.preflight ?? (deps.orchestrator ? permissiveBackendPreflight : probeBackendUsable)` appeared verbatim in six run use-cases (verification, extraction, research, relevance, reference scan, auto-repair rematch). Resolution: `resolvePreflight(deps)` in `lib/pipeline/health.ts` is now the single definition of that convention, with the rationale (an injected orchestrator never talks to real CLIs) documented once.

### Q-04 - `applyExtractionOutput` mixed classification and transition sweeping into one ~220-line function

`lib/pipeline/extraction/apply-extraction-output.ts` contained a three-level nested ternary computing a new claim's routing reason, and an inline loop pulling settled claims to `recheck_required`. Resolution: extracted `classifyCreationReason` (pure, independently readable) and `pullSettledClaimsToRecheck`. The two extraction loops themselves remain in the orchestrating function on purpose: they share transactional dedupe state (`byNormalizedText`, minted-id bookkeeping) whose TOCTOU reasoning is documented on the function, and splitting that state across helpers would obscure rather than clarify it.

### Q-05 - `runReferenceScanOnce` was a single ~230-line function spanning six concerns

`lib/pipeline/sources/reference-scan/run-reference-scan.ts` inlined footnote/regex correlation, the LLM channel with its degradation handling, dedupe/partition of LLM citations, and sequential Crossref resolution in one body. Resolution: decomposed into `buildRegexSeeds`, `runLlmChannel`, `partitionLlmReferences`, and `resolveViaCrossrefTitle`, each carrying the domain commentary that previously interrupted the main flow. The main function is now a legible pipeline; the identity cross-check and persistence stay inline because their ordering constraints (quota before Crossref, one final transaction) are the function's actual job.

### Q-06 - A type escape hatch in the project page's view-model assembly

`app/projects/[id]/page.tsx` passed `source as Record<string, unknown>` into `identifierKindOf`, sidestepping the `Source` type — the one `unknown` cast in an otherwise strongly-typed codebase. Resolution: the function is now typed against `Source` directly; since `Source` is a Zod loose object, the CSL passthrough fields (`DOI`, `URL`) are reachable without any cast, exactly as `lib/pipeline/verification/stage1/source-check.ts` already did.

### Q-07 - Testable pure logic sat inline in the `SourcesRail` client component

~60 lines of row-bucketing rules (candidate/work-item merging by shared id, corrections accumulated per source, standalone fallback for orphans) lived inline in the `SourcesRail` client component, where the existing node-environment test setup could not reach them — unlike comparable derivations in `lib/pipeline` (`deriveSourceLifecycles`, `deriveOpenRepairActions`), which are pure and tested. Resolution: the bucketing moved to `app/projects/[id]/workbench/derive-rail-buckets.ts` as a pure derivation with behavioral unit tests pinning the documented bucketing semantics. (The other pure-logic candidate in `app/`, `createRunDoneLatch` in `app/lib/useRunFeed.ts`, turned out to already be covered by `tests/run-done-latch.test.ts` — the `app/` test gap is narrower than it first appears, though it remains real for components; see Q-10.)

## Known trade-offs documented, deliberately not changed

### Q-08 - The auto-chain's dynamic-import cycle

`lib/pipeline/runs/auto-chain.ts` breaks a genuine import cycle with eight memoized `await import(...)` calls (its comments say so explicitly). The clean resolution — an event/port interface both sides depend on — is an architectural change to the pipeline's most intertwined module. It was left untouched: the workaround is locally documented at every site, and restructuring it shortly before evaluation would trade a cosmetic improvement for regression risk in the code path that sequences every automated run.

### Q-09 - The 25-method `RegisterTransaction` interface

The transaction interface is a deliberate single-writer design: one file is the only place chain-linked writes can happen, which is exactly the property the audit trail depends on. Splitting it into per-domain capabilities would distribute that invariant across files. The size is accepted; Q-01 removed the mechanical duplication inside it.

### Q-10 - No component/browser test infrastructure for `app/`

`app/**` is excluded from the coverage ratchet and has no React component or E2E test tooling (already noted as S-10 in the software review). Q-07 narrowed the gap where it was cheapest — pure logic now tests under the existing node setup — but component/E2E coverage would require new tooling (`jsdom`/Testing Library or Playwright) and is left as the documented next step.

## Verification

`npm run check` (ESLint, Prettier, `next typegen` + `tsc`, Vitest with coverage thresholds) passes after the refactor; the architecture test and the pinned barrel surfaces are unchanged.
