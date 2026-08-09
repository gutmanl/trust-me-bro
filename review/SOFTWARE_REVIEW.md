# Comprehensive software review

Review date: 2026-08-08
Repository baseline: Next.js 16.3.0, React 19.2.8, TypeScript, local single-user application with CLI, register/state machine, LLM adapters, source ingestion, review UI, warm runs, metrics, and `.tmb` export/import.

## Overall assessment

The codebase has a strong engineering base for a research prototype: clear domain boundaries, strict runtime schemas, atomic locked writes, explicit transitions, deterministic projections, content-addressed blobs, bounded adapter retries/concurrency, detailed domain tests, and a standalone package path. The full automated check passes with 628 tests and high coverage.

The main risks sit exactly where the product makes its strongest promises. The hash chain does not protect most materialized claim/evidence/source content, repaired wording is not reflected in the checked briefing, untrusted HTML executes on the application origin, CLI agents have insufficiently constrained read/data boundaries, and package tracing includes the whole repository. These should be fixed before the prototype is distributed or used as the basis of evaluation claims about auditability, privacy, or end-user correctness.

## Scope and method

Reviewed architecture and documentation, register/schema/persistence/state machine, source capture/revision/full-text paths, adapters/prompts/traces, verification and repair, warm reuse, projections/metrics, server actions/routes, export/import/CLI, packaging, and UI workflow.

Verification included the full quality suite, production and standalone builds, dependency audit, package dry-run, built-app desktop/mobile smoke tests, a register-tampering reproduction, and a harmless stored-HTML execution proof. No application source code was modified.

## Findings

### S-01 - High - Hash-chain verification accepts tampered canonical content

**Evidence**

- `lib/register/chain/appender.ts:82-90` puts only claim `history[]` entries and `project_events[]` in the chain.
- `lib/register/chain/verify.ts:25-40` accurately documents entry/tail behavior, but `lib/register/chain/verify.ts:82-94` checks only current claim status against the final history transition.
- The register declares `claims.json` the sole source of truth (`lib/register/schema/register.ts:11-23`).
- Transaction methods mutate claim text, evidence, current existence checks, relations, support/calibration, source snapshots, and configuration (`lib/register/persistence/store.ts:419-482`). Those values are not generally recomputed from or committed by the chain.
- Reproduction: starting from the valid repository `chainedFixture`, changing `claim.text`, `evidence.verbatim_excerpt`, and a source title remained schema-valid and `verifyChain` returned `ok: true`.
- Directory-mode `tmb verify` reports a valid chain and valid blob checksums after this class of edit (`cli/verify.ts:38-104`).

**Impact**

Silent changes to central audit data are accepted as valid. This defeats the user-facing interpretation of a tamper-evident claim register. Export manifests hash all files, but an unsigned manifest can be regenerated; only retention of an external original commitment helps.

**Remediation**

Use event sourcing and verify a reconstructed projection, or include a canonical state/root hash in every chained entry and recompute it during verification. Cover project/config/sources/claims/evidence/verification results, not only transitions. Add negative tests for every material field and make CLI output state the exact protection scope.

### S-02 - High - Checked briefings can retain a false original sentence after repair

**Evidence**

- Claim repair writes a new `claim.text` (`lib/register/persistence/store.ts:464-465`).
- `lib/register/projection/briefing-view.ts:84-124` parses and returns original briefing paragraphs unchanged.
- `lib/register/projection/render-briefing.ts:86-90` renders those original paragraphs.
- Its marker contains only claim ID, status, and evidence numbers (`lib/register/projection/render-briefing.ts:29-35`), not the current claim text.
- The web marker likewise shows ID/status; corrected wording is visible only after opening detail (`app/projects/[id]/review/BriefingPane.tsx:71-110`).

**Impact**

A `GEPRÜFT` Markdown export can present the original incorrect/overstated wording next to a confirmed marker while omitting the accepted correction. This is a correctness failure in a primary deliverable, not merely a presentation preference.

**Remediation**

Store an exact claim span or structured paragraph projection. Render accepted wording inline and visibly mark replaced original wording, with the original preserved in history. If spans cannot be introduced, render a mandatory current-claim block containing `claim.text` below the paragraph and label the paragraph as immutable source material. Add a golden test for repair followed by export.

### S-03 - High - Frozen HTML is active same-origin content (stored XSS)

**Evidence**

- `lib/pipeline/blobs.ts:18-29` maps `.html`/`.htm` to `text/html`.
- `app/api/projects/[id]/blobs/[...path]/route.ts:21-27` returns those bytes inline with no `Content-Disposition`, sandbox Content Security Policy, `X-Content-Type-Options: nosniff`, or separate origin.
- Remote HTML is a normal captured source type.
- Browser proof: a harmless script in an isolated stored HTML snapshot ran from the blob URL and changed the document title to `ACTIVE-SNAPSHOT` on the application origin.

**Impact**

A malicious source snapshot can execute with the same origin as the local application. It can issue same-origin requests and attempt access to project data/actions. Loopback binding limits network reach but does not protect the user who opens a malicious research source.

**Remediation**

Do not serve untrusted HTML as active same-origin HTML. Prefer an inert text view or forced download. If rendering is required, sanitize and serve from a credentialless separate origin with a restrictive sandbox CSP. Add security headers and a browser regression test containing scripts/event handlers/iframes.

### S-04 - High - CLI-agent read and prompt-injection boundaries are not application-enforced

**Evidence**

- Claude is launched with `Read,Glob,Grep`, `--permission-mode dontAsk`, and the project as cwd (`lib/adapters/backends/claude/claude-backend.ts:17-21,70-87`).
- `--setting-sources project` and `--strict-mcp-config` restrict settings/MCP sources; they do not constitute a demonstrated filesystem read sandbox.
- Codex uses a read-only sandbox (`lib/adapters/backends/codex/codex-backend.ts:42-54`), which prevents writes but is not an application-level assertion that only project files are readable/transmittable.
- Prompt templates interpolate untrusted briefings, claims, excerpts, reviewer complaints, research questions, and source metadata directly. The templates contain no explicit “treat following data as untrusted, never follow its instructions” boundary.
- Extraction/attribution/repair prompts invite source-file reads.

**Impact**

A prompt-injected document can attempt to redirect an agent to read other local files and place their contents in schema-valid output sent to a hosted provider. The actual exploitability depends on each installed CLI’s evolving sandbox policy, but the application itself does not establish the claimed boundary.

**Remediation**

Run adapters inside an OS/process sandbox with a read-only mount containing only the current project and required templates. Avoid tools when all required content can be passed as data. Use explicit untrusted-data delimiters and instruction hierarchy, impose input/output size limits, redact secrets, and add adversarial prompt tests. Document exactly what is transmitted to providers.

### S-05 - High - Standalone packaging traces and ships the whole repository

**Evidence**

- Packaging enables Next standalone output (`next.config.ts:3-10`), while dynamic `path.resolve` of the workspace root at `lib/identity/config.ts:40` triggers a Turbopack whole-project tracing warning.
- `package.json:8-11` ships `.next/standalone`.
- The package dry-run contained 2,020 files, 9,804,676 compressed bytes and 39,017,080 unpacked bytes.
- The standalone tree included 234 `lib` files, 181 coverage files, 66 `app` files, tests, CLI/scripts, configuration, repository instructions, and build metadata.
- The application’s development default workspace is `./workspace` (`lib/identity/config.ts:11,40-42`), so user/project data below the repository root can be included if present when building.

**Impact**

The package is needlessly large and exposes source/test/coverage material. More seriously, a package built after using the default in-repository workspace can unintentionally disclose research projects and source snapshots.

**Remediation**

Keep runtime workspaces outside the source root, make output tracing statically bounded (`outputFileTracingIncludes/Excludes` or a documented Turbopack-ignore strategy), and stage the package from an explicit allowlist. Add CI that builds with a sentinel secret/workspace and fails if it appears in `npm pack --dry-run` or the tarball. Exclude coverage/tests/source not required at runtime.

### S-06 - Medium - Source fetching and bundle import lack resource/trust boundaries

**Evidence**

- `lib/pipeline/sources/document.ts:35-74` accepts any HTTP(S) URL.
- `lib/pipeline/sources/node-http-fetcher.ts:11-31` follows redirects and buffers the entire response with `arrayBuffer()`; there is no private/link-local address rejection, redirect-hop validation, maximum bytes, or declared MIME enforcement.
- Server Actions accept bundles up to 50 MB (`next.config.ts:11-16`), copy the complete upload into memory (`app/projects/import/actions.ts:12-26`), and `unzipSync` the archive without entry-count or expanded-size limits (`lib/export/zip.ts:25-45`).
- Source uploads are likewise passed as complete buffers without an application size policy.

**Impact**

Source URLs can reach local/internal HTTP services (SSRF) and large responses or compressed bundles can exhaust process memory/CPU. The single-user workflow lowers attacker reach but imported/untrusted research artifacts remain a realistic input.

**Remediation**

Resolve and reject loopback/private/link-local/metadata addresses before every request and redirect, or allowlist schemes/domains for the evaluation. Stream with hard byte/time/redirect limits. Enforce upload, entry-count, per-entry, total-expanded, and compression-ratio caps before/while extracting. Prefer asynchronous/streaming parsing where practical.

### S-07 - Medium - Evidence history is not bound to source snapshot revisions

**Evidence**

- `SourceSnapshot` carries revision and checksum; superseded snapshots are retained (`lib/register/schema/source.ts:11-27,46-55`).
- `Evidence` stores `source_id` but no revision/hash (`lib/register/schema/evidence.ts:30-52`).
- `reviseSource` rotates the snapshot and marks selected claims for recheck (`lib/pipeline/sources/revise.ts:102-151`).
- Existence check, resolved relation, support degree, and calibration result are current overwrite fields (`lib/register/persistence/store.ts:467-482`).

**Impact**

Old excerpts and judgments cannot be tied unambiguously to old bytes. After multiple revisions, the audit history says a recheck occurred but does not preserve a complete per-stage, per-snapshot result history.

**Remediation**

Add `snapshot_sha256`/`source_revision` to evidence and every verification attempt. Store stage results as append-only attempts, derive current state, validate that referenced blobs exist, and show the bound revision in UI/export. Add migration and multi-revision tests.

### S-08 - Medium - Positive warm-run decisions live only in unchained traces

**Evidence**

- `lib/pipeline/warm/run-relevance.ts:16-22,281-289` deliberately performs no register write for a positive result.
- Completion records only aggregate counts (`lib/pipeline/warm/run-relevance.ts:330-342`).
- Trace files are created once under `traces/` (`lib/adapters/runtime/trace-sink.ts:7-30`) but are outside `allChainEntries`.

**Impact**

Deleting or altering a positive trace does not break the register chain, and the register cannot reconstruct which adopted claims received which positive reasoning. This conflicts with claim-level auditability and weakens warm-run provenance.

**Remediation**

Append a chained per-claim relevance decision or commit the trace ID/hash in a chained entry. Verify trace closure and hashes in directory mode, not only as incidental files in an exported bundle.

### S-09 - Medium - Metric names overstate what the code computes

**Evidence**

- Completeness is `claim.evidence.some(existence_check === "bestanden")` (`lib/register/projection/metrics.ts:100-116`).
- “Nachweiskorrektheit” is a support-degree distribution for terminal human outcomes (`lib/register/projection/metrics.ts:148-158`).
- Warm metrics provide adoption/settled/routed counts (`lib/register/projection/metrics.ts:219-234`), not savings or quality preservation.
- The effort timer clips inactive gaps at 30 seconds and describes itself as casual (`lib/pipeline/adjudication/effort-timer.ts:1-13,31-64`).

**Impact**

Consumers can treat the metrics as provenance coverage, correctness, total effort, and reuse savings although those constructs are not measured. This directly risks invalid thesis analysis.

**Remediation**

Rename metrics to their literal computations, add definitions to API/UI/export, and introduce independent reference labels, repeated-run metrics, total-task measures, and paired cold/warm resource fields. Persist enough raw events/usage data to recompute analyses.

### S-10 - Medium - Critical browser workflows lack automated browser coverage

**Evidence**

- The test suite is broad at domain, adapter, route/helper, CLI, and persistence levels, but no Playwright/Cypress/browser E2E suite is tracked.
- The thesis itself states that React components are not tested (`../thesis/manuscript/umsetzung.md:788-791`).
- The active-HTML problem and repaired-briefing presentation gap are browser/product behaviors that unit/domain coverage did not catch.

**Impact**

Regressions in setup, form submission, source viewing, run controls/SSE, adjudication/repair, export/download, responsive layout, focus, and accessibility can pass `npm run check`.

**Remediation**

Add Playwright coverage for the primary end-to-end workflows using mock adapters and an isolated workspace. Include repair-to-export assertions, hostile HTML, keyboard-only adjudication, interrupted/resumed runs, import/export, mobile viewports, accessibility checks, and console/network error assertions.

### S-11 - Medium - Exact model/runtime provenance can degrade to generic labels

**Evidence**

- Claude returns the backend name if its CLI envelope exposes no model (`lib/adapters/backends/claude/claude-backend.ts:32-47`).
- Codex returns `codex` if no event model is found (`lib/adapters/backends/codex/codex-backend.ts:94-101`).
- Trace schema records prompt version/hash and model but not CLI version, application commit, inference configuration, or token/cost usage (`lib/adapters/trace/envelope.ts:14-45`).

**Impact**

Repeated-run changes may be impossible to attribute precisely, and generic model strings can look more reproducible than they are.

**Remediation**

Fail or explicitly mark `model: unknown` when unresolved; record CLI version, application/schema commit, relevant settings, provider account mode, and usage when available. Expose incomplete provenance in UI/export and evaluation filters.

### S-12 - Low - Project-ID help omits a required prefix

**Evidence**

- The form says the ID may contain lowercase letters, digits, dot, underscore, and hyphen (`app/projects/new/CreateProjectForm.tsx:62-80`).
- Validation requires `^proj_[a-z0-9][a-z0-9._-]*$` (`lib/register/schema/primitives.ts:29-34`).

**Impact**

Users who replace the suggested value with a syntactically described value lacking `proj_` get a server-side error.

**Remediation**

State “must start with `proj_`” beside the field and use shared client/server validation to provide inline feedback without duplicating the regex.

## Strengths

- Clean module boundaries documented in `ARCHITECTURE.md` and reinforced by architecture tests.
- Strict Zod schemas, JSON Schema generation, and referential-integrity validation.
- Atomic temp/rename writes and per-project locking.
- Explicit, guarded state transitions and human decision objects.
- Content-addressed blobs with checksum verification and revision retention.
- Deterministic projections/CSV/export ordering and byte-preserving bundle round trips.
- Bounded adapter attempts, timeouts, rate-limit handling, process concurrency, trace envelopes, and prompt hashes.
- Good unit/integration breadth: 78 test files, 628 passing tests, 93.75% statement and 88.63% branch coverage.
- Loopback-only packaged launcher and isolated workspace/config support.
- No production dependency advisory reported by the audit on the review date.

## Recommended remediation order

1. Fix S-01, S-02, and S-03 before producing evaluation artifacts.
2. Bound agent data access and package tracing (S-04/S-05) before distribution or real confidential inputs.
3. Add snapshot-specific/versioned verification records and chain warm relevance decisions (S-07/S-08).
4. Add network/archive limits (S-06).
5. Correct metric semantics and provenance fields before collecting results (S-09/S-11).
6. Add browser E2E/security regression coverage and the project-ID help fix.

## Verification record

| Command/check | Result |
|---|---|
| `npm run check` | Passed: ESLint, Prettier, Next type generation, TypeScript, coverage |
| Test suite | 78 files / 628 tests passed |
| Coverage | 93.75% statements; 88.63% branches; 96.31% functions; 93.75% lines |
| `npm run build` | Passed with whole-project tracing warning |
| `npm run package:build` | Passed with the same warning |
| `npm audit --omit=dev --json` | 0 reported production vulnerabilities among 53 production dependencies |
| `npm pack --dry-run --ignore-scripts --json` | 2,020 files; 9,804,676 bytes packed; 39,017,080 unpacked |
| Built standalone browser smoke | Setup, project dashboard, briefing import, source UI; mobile 375x812 checked |
| Register tamper reproduction | Schema remained valid and `verifyChain` incorrectly returned `ok: true` |
| Stored HTML reproduction | Harmless snapshot script executed on application origin |

## Residual review limits

- No real Claude/Codex research jobs were run; no provider quota or confidential data was consumed.
- Browser testing was targeted rather than full cross-browser/accessibility coverage.
- SSRF and prompt-injection findings are code-grounded risks; no destructive network/file exfiltration proof was attempted.
- Dependency audit results are time-specific to 2026-08-08.
- The review did not change application code.
