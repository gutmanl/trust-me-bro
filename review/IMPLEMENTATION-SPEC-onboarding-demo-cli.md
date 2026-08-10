# TMB-54 — Implementation spec: evaluator onboarding, demo mode, shippable CLI, product docs

Derived from TMB-53 (findings catalogue). This document is **normative for the implementation
run** and is written to be executed unattended: every design question TMB-53 left open is
answered here. **If something still seems ambiguous, prefer the decision recorded in §2 over
your own judgement, and note the ambiguity in the final report rather than redesigning.**

Scope: TMB-53 bundle **A** (findings 1–3), plus a documentation rewrite, plus in-UI research
guidance, plus review finding S-05 folded into the packaging task. Bundles B, C, D are out of
scope.

Tonight's queue, in order: **this spec's T1–T8**, then **TMB-56** (review findings S-03, S-06,
S-12), then **TMB-57** (review finding S-02). Both follow-on tickets are specced to the same
standard and carry no open questions — see §3's closing note before starting either.
**TMB-55** (automated in-app research) is **not** in the queue: it needs a thesis-appendix
changelog entry and a methodological decision that is proposed but not confirmed.

---

## 0. Preconditions — run these first, in order

```
cd /home/user/trust-me-bro
npm ci                      # node_modules is NOT present in a fresh container
node --version              # must be >= 20.9
npx vitest run              # baseline: everything green BEFORE any change
```

The repo's `SessionStart` hook (`.claude/settings.json`) attempts `npm install` but pipes all
output to `/dev/null` and always `exit 0`s, so **it fails silently**. Do not rely on it.
If `npm ci` fails, stop and report; do not proceed on a partial install.

`AGENTS.md` requires reading the bundled Next docs before writing Next code. They are at
`node_modules/next/dist/docs/` **after `npm ci`** — this version is Next 16.3.0. Relevant:
`01-app/02-guides/forms.md`, `02-guides/server-actions.md`,
`01-app/03-api-reference/03-file-conventions/{layout,error,not-found}.md`.

`AGENTS.md` also says `next dev` rewrites its own text block. If it reappears as an
uncommitted change, commit it with the work rather than reverting it.

### If you dispatch subagents: notifications are unreliable here — do not wait on them

Observed in this environment: background **Bash** completion notifications fire reliably.
Background **subagent** notifications do **not** — three exploration agents completed
successfully and never notified, and `ListAgents` then reported "No reachable agents". A
fourth agent notified normally. Treat notification as best-effort, never as a signal you
can block on. `run_in_background: false` does **not** make an agent synchronous here.

**Never idle-wait for a subagent.** If one appears to hang, recover its result from its
transcript instead — the work is usually finished even when the notification is lost:

```
# The agent's output_file is a JSONL transcript. NEVER cat/Read it whole (~300KB, will
# blow up your context). Extract only the final assistant message:
python3 - <<'PY'
import json
p = "<output_file path from the Agent tool result>"
last = None
for line in open(p, encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("type") == "assistant":
        c = d.get("message", {}).get("content", [])
        if isinstance(c, list):
            t = "".join(b.get("text", "") for b in c
                        if isinstance(b, dict) and b.get("type") == "text")
            if t.strip():
                last = t
open("/tmp/agent-report.md", "w", encoding="utf-8").write(last or "")
print(len(last or ""))
PY
```

Then `Read` `/tmp/agent-report.md`. A non-zero length means the agent finished and the
report is usable. Note also that `stat` size/mtime on these transcripts is unreliable in
this container (reports 110 bytes for a 300KB file) — use `wc -l` to judge activity, not
`ls -l`.

Given the above, prefer doing this work directly over dispatching subagents. The tasks below
are sequential and each is small enough not to need fan-out.

---

## 1. Binding constraints (violating any of these fails the run)

1. **`tests/architecture.test.ts` is binding and must never be weakened.** Any new public
   use-case must be added to its `lib/*` barrel **and** to that test's pinned surface list.
   Internals must stay pinned `undefined`.
2. **`app/**` may runtime-import only from `@/lib/pipeline`** (plus three pinned pure deep
   imports). Type-only imports are exempt.
3. **`process.env` only in `lib/identity`.** Raw `fs` writes only in
   `lib/register/persistence/atomic-write.ts` and `lib/identity/config-file.ts`.
4. **`cli/**` may import only `../lib/register` and `../lib/export`** — not sub-barrels.
5. **Code English, user-facing display tier German.** New UI copy, new `PipelineError`
   messages and new persisted `reason` strings are German. Identifiers, enum values and
   actor tokens are English.
6. **`schema/claims.schema.json` is generated** — `npm run generate:schema`, never hand-edit.
7. **Prompt templates are versioned, never edited in place.** Not expected to change here.
8. **Coverage thresholds ratchet up only**: lines 90 / functions 90 / branches 85 /
   statements 90, over `lib/**` and `cli/**`. `app/**` and `bin/**` are outside the gate —
   so new `lib/` code needs tests, new `app/` code does not (but see §3 task tests).
9. **`npm run check` must pass** before the final push.
10. CI runs ubuntu **and windows**. Windows is the primary eval platform — no
    POSIX-only path or shell assumptions.

### Verified facts you do not need to re-derive

- `BackendRef.cli` is `z.string().min(1)` (`lib/register/schema/project.ts:52-53`) — a free
  string, **not an enum**. Adding a `mock` backend id is therefore **not** a register-schema
  change and needs **no thesis-appendix changelog entry**.
- `ActorId` is `/^(human|system):[a-z0-9][a-z0-9_-]*$/`
  (`lib/register/schema/primitives.ts:52-57`) — `system:demo_seed` is valid with no schema change.
- `createMockBackend` is already exported from `lib/adapters/index.ts` and already pinned in
  `tests/architecture.test.ts` — but `lib/adapters/registry.ts:23-48` has **no `case "mock"`**,
  so it is unreachable at runtime.
- The allow-list of selectable backends lives only in `lib/pipeline/projects.ts`
  (`BackendCli`, `MODEL_FAMILY`, `allowedBackendClis`) and `app/lib/parse-backend-cli.ts`.
- `anthropic-api` is the exact precedent to copy for a gated extra backend: double gate in
  `lib/pipeline/projects.ts:49-53`, its own health branch `apiBackendStages` in
  `lib/adapters/health/index.ts:51-79`, conditional `<option>` in both forms.
- `lib/pipeline/health.ts:24-36` requires a `projectId` because it reads the project's
  `config.backends` — that is why health is invisible before a project exists.
- **THESIS REPO IS OUT OF SCOPE.** No change in this spec alters the project file format.
  Do not edit `trust-me-bro-thesis`.

---

## 2. Design decisions — all questions TMB-53 left open, answered

### D1 — Is a demo/mock backend acceptable in a _verification_ tool? YES, with chained provenance.

TMB-53 asks whether a demo backend must be "visibly quarantined (badge, read-only demo
project, refuse export)". **Decision: badge it, and write its provenance into the hash chain.
Do NOT make it read-only and do NOT refuse export.**

Rationale: the integrity risk is a demo bundle being mistaken downstream for real verification
work. Refusing export prevents that only while the bundle stays inside the app, and it costs
the evaluator the entire export/verify story — which is the thesis's headline feature. Writing
the actor `system:demo_seed` into the chained history of every seeded entry makes a demo bundle
**self-identifying under `tmb verify`**, tamper-evidently, forever. That is a stronger guarantee
than a UI prohibition, and it needs no schema change.

Explicitly considered and rejected: (a) refusing export — loses the headline feature, weaker
guarantee; (b) a `demo` flag in the bundle manifest — changes `MANIFEST_VERSION`, a format
change, more risk for less benefit.

### D2 — Is the demo gated behind an env var? NO.

`anthropic-api` is double-gated because it costs money and is an incomplete spike. The demo
exists precisely so that someone with **no** paid CLI can use the app; requiring
`TMB_ENABLE_DEMO_MODE=1` would defeat its only purpose. The `mock` backend is therefore
always selectable. Its safety comes from D1 (chained provenance + badge), not from a flag.

### D3 — Demo project: created on demand, not auto-created.

Offered as an explicit action in the final wizard step and on the empty `/projects` page
("Beispielprojekt anlegen"). Never created silently at install time. Creating it twice must
fail cleanly with the existing `ProjectAlreadyExistsError` path (fixed id, see §3 T3).

### D4 — Wizard shape: one route, step in a query parameter.

`/setup?step=n`, server-rendered, one server action per step. **Not** separate routes —
`proxy.ts` redirects everything except `/setup` while identity is unconfigured, so extra
routes would each need to be added to that exemption.

"Setup complete" keeps its current meaning — **actor handle present**
(`isIdentityConfigured`). Steps after the handle are optional and skippable, so `proxy.ts`
logic is unchanged. This matters: a wizard that made setup "complete" only at the last step
would lock a user out of the app if they closed the tab mid-wizard.

Step order (step 1 must come first for the reason in `app/setup/actions.ts:19-26` — no
identity means `IdentityNotConfiguredError`, which is not a `PipelineError` and cannot be
rendered as form state):

1. Actor handle (required)
2. Workspace directory (optional, defaulted)
3. Backend detection + live login probe (optional, skippable)
4. Unpaywall e-mail (optional)
5. Finish: create first project **or** create the demo project

### D5 — Workspace root is settable during first run only.

`writeIdentityConfig` already accepts `workspaceRoot`; no UI passes it. Expose it in wizard
step 2 only. **Do not** expose it in later settings: moving the root after projects exist
would orphan them, and migration is out of scope. State this in the German UI copy.

### D6 — Actor handle becomes editable, at a new installation-level settings route.

New route `/settings` (distinct from the existing per-project
`/projects/[id]/settings`). Editing the handle changes the actor recorded in **future**
history entries only; past entries keep the old handle, which is correct for an append-only
audit trail. The German copy must say so explicitly.

### D7 — Installation-level health check, no project required.

New use-case `getInstallationBackendsHealth()` that probes the known CLIs without reading any
project config. Used by wizard step 3 and `/settings`. This is the seam that fixes "you must
create a project to discover you cannot use it".

### D8 — Node version: runtime check in the launcher, not `engine-strict`.

Add an explicit `process.versions.node` check at the top of `bin/trustmebro.mjs` that exits
with a clear message naming the required and actual version. **Do not** add
`.npmrc engine-strict=true` — it changes install behaviour for contributors and does not help
someone who already installed the tarball, which is the case that matters.

### D9 — CLI packaging: see §3 T1. The approach is fixed there; do not redesign it.

### D10 — Documentation voice: product, not thesis.

See §3 T7 for exact scope. Do **not** touch `CLAUDE.md`, `AGENTS.md`,
`review/SOFTWARE_REVIEW.md`, `lib/register/projection/__fixtures__/briefing-golden.md`
(golden fixture — editing it fails tests), or `lib/adapters/prompts/**`.
Do **not** sweep `TMB-nnn` comments out of source files (301 refs / 142 files) — out of scope.

### D11 — Review findings: one folded in, three split out to TMB-56

`review/SOFTWARE_REVIEW.md` is dated 2026-08-08 and is **not** wholesale current — TMB-53
already found S-01 remediated by the `state_root` commitment. Every finding below was
**re-verified against the code on 2026-08-10** and is still open.

Only one is in this run:

- **S-05 (High)** — `next.config.ts` still has no `outputFileTracingIncludes/Excludes` and
  the packaged tarball is assembled by tracing, not by an allowlist. The review measured
  2,020 files / 39 MB unpacked, including tests, coverage and — if a workspace sits under
  the repo root — real user project data. T1 is the one task that already touches packaging,
  so the guard belongs there rather than in a separate pass. → folded into **T1**

**S-12, S-03 and S-06 were moved out of this spec into TMB-56** to keep this run finishable.
They are re-verified and ready to implement, but they are not this run's job — **do not start
them here**, even if a task finishes early:

- **S-12 (Low)** — `app/projects/new/CreateProjectForm.tsx:78` describes the id as
  "Kleinbuchstaben, Ziffern, …" without stating the required `proj_` prefix, while
  `lib/register/schema/primitives.ts` enforces `^proj_[a-z0-9][a-z0-9._-]*$`.
- **S-03 (High)** — `app/api/projects/[id]/blobs/[...path]/route.ts:21-27` returns stored
  bytes with only `content-type` and `cache-control`: no `X-Content-Type-Options`, no
  `Content-Disposition`, no sandbox CSP, so a captured HTML snapshot executes as active
  same-origin content.
- **S-06 (Medium)** — no byte/time/redirect caps on source fetching, no entry-count or
  expansion caps on bundle import.

Deliberately not pulled into **either** ticket, with reasons — do not start these:

- **S-02 (High, repaired claim text never reaches `briefing.md`)** — a real correctness bug
  in the primary deliverable, but fixing it properly means a projection redesign (claim
  spans, or a mandatory current-claim block) and it rewrites the
  `briefing-golden.md` fixture. That deserves its own ticket and its own spec, not a slot in
  an overnight run whose other tasks must not be destabilised.
- **S-10 (browser E2E coverage)** — large new test suite; separate effort.
- **S-04, S-08, S-09, S-11** — unchanged from TMB-53's assessment; orthogonal to this bundle.

### D12 — Research guidance in the UI: yes. Automated research: separate ticket.

The tool verifies a briefing the user researched **elsewhere**, but nothing in the UI says
where or how to produce one — a new user with no briefing simply dead-ends. Adding short,
concrete guidance is squarely an onboarding fix and belongs here (**T4**).

**Generating the briefing in-app is a separate feature and is NOT in this run.** It needs a
new `research` job kind, a new versioned prompt template, mock outputs, a pipeline use-case
with its own SSE run, and — decisively — two new `ProjectEventType` enum values for the run
bracket. `ProjectEventType` is a `z.enum` (`lib/register/schema/enums.ts:136-165`), so that
is an additive project-file-format change requiring a dated German changelog entry in the
thesis appendix, exactly as TMB-52 did. That coupling makes it the wrong shape for an
unattended run bundled with unrelated work. It is specced separately as **TMB-55**.

(Useful for that later ticket, verified now: `BriefingImport.tool` is `z.string().min(1)`
(`lib/register/schema/project.ts:9-14`), so a self-generated briefing can record its own
provenance in the existing field with no schema change.)

---

## 3. Tasks — execute in this order, one commit each

Each task is independently landable and independently verifiable. **Commit and push after
each task passes its own verification.** Do not batch. If a task cannot be completed, commit
what is green, record the blocker, and continue with the next task — do not abandon the run.

**The order is a priority order.** T1–T6 are the bundle proper; T7–T8 close the run. If time
or context runs out, stop cleanly after the task in hand, push, and report exactly where you
stopped — **do not skip ahead to later tasks** and do not leave a half-finished task
uncommitted. Finishing five tasks properly beats starting eight.

**If you finish all eight tasks with time to spare**, continue into the follow-on queue, in
this order, and only in this order:

1. **TMB-56** — review findings S-03, S-06, S-12. Fully specced in the ticket, no open
   questions. Same commit-per-task, push-after-each discipline.
2. **TMB-57** — review finding S-02 (repaired claim text never reaches `briefing.md`). Fully
   specced in the ticket. Note it deliberately rewrites
   `lib/register/projection/__fixtures__/briefing-golden.md`, which T7 told you not to touch —
   that instruction applies to the _documentation rewrite_ only. Regenerating the golden
   fixture is the expected outcome of TMB-57 and must be reviewed as a real diff.

**Do not start TMB-55** (in-app research). It carries a methodological decision recorded in
that ticket but not settled, and it needs a thesis-appendix changelog entry — both wrong for
an unattended run.

Branch: `claude/start-rs0ezk` (already checked out, currently identical to `main`).
Push with `git push -u origin claude/start-rs0ezk`; retry network failures 4x with backoff.
**Do not open a pull request.**

### T1 — Make `tmb verify` runnable from the packed tarball

Fixes TMB-53 finding 2. See the packaging addendum in §5 for the chosen mechanism, which is
binding.

**Also fold in S-05 here** (D11): the packaged tarball is currently assembled by Next's
tracing rather than an allowlist, which the review measured at 2,020 files / 39 MB unpacked
including tests and coverage — and, if a workspace directory sits under the repo root, real
user project data. Constrain it: add `outputFileTracingIncludes`/`outputFileTracingExcludes`
to `next.config.ts`, and assert in the T1 verification that no `workspace/`, `coverage/`,
`tests/` or `.ts` source leaks into the tarball. Do not let the new `dist/` entries widen the
surface.

**Mechanism is decided — do not deliberate.** Use `outputFileTracingExcludes` in
`next.config.ts`, under the same `TMB_BUILD_TARGET === "package"` branch that already sets
`output: "standalone"`. Exclude at minimum `**/coverage/**`, `**/tests/**`, `**/*.test.ts`,
`**/__fixtures__/**`, `**/workspace/**`, `**/.git/**`. Measure with `npm pack --dry-run`
before and after. **If that alone does not bring the count down**, do not redesign: add an
explicit prune step to `scripts/prepare-standalone.mjs` that deletes those directories from
`.next/standalone` after the copy, and make the script fail loudly if a `workspace/`
directory is found there at all. Belt-and-braces is the intended outcome, not a fallback to
choose between.

Acceptance:

- A tarball built with `npm pack` contains a runnable verify entry point and a `tmb` bin.
- `npm pack --dry-run` contains no `workspace/`, no `coverage/`, no `tests/`, and no `.ts`
  or `.tsbuildinfo` files.
- `tests/e2e/lifecycle.e2e.test.ts` and `tests/e2e/bundle.e2e.test.ts` invoke the **shipped**
  artifact, not `node_modules/tsx/dist/cli.mjs`, so the tests prove what actually ships.
- `tests/architecture.test.ts` rule 15 still passes unmodified.
- The tarball does not grow beyond what §5 specifies; record `npm pack --dry-run` file count
  and unpacked size in the commit message, before and after.

Verify: `npx vitest run tests/e2e cli` then `npm pack --dry-run --json`.

### T2 — Make the mock backend reachable and visibly badged

- `lib/adapters/registry.ts`: add `case "mock": return createMockBackend(options)`.
- `lib/pipeline/projects.ts`: add `"mock"` to `BackendCli`, and to `MODEL_FAMILY` with the
  family value `"mock"` (its own family, so
  the divergence rule treats it as distinct) and `allowedBackendClis()`. It is allowed as
  **primary** (unlike `anthropic-api`, it implements every job kind).
- `app/lib/parse-backend-cli.ts`: add `"mock"` to `BACKEND_CLIS`.
- Both forms (`app/projects/new/CreateProjectForm.tsx`,
  `app/projects/[id]/settings/SettingsForm.tsx`): add the `<option>`, labelled in German as a
  demonstration backend, with a short hint that it produces canned results and is not a real
  verification.
- Health: add a `mock` branch in `lib/adapters/health/index.ts` modelled on `apiBackendStages`
  — it is always "ready", no PATH/version/login probe.
- New derived helper for the badge (see D1): a project is a demo project iff
  `config.backends.primary.cli === "mock"`. Put it in `lib/pipeline`, export it from the
  barrel, pin it in `tests/architecture.test.ts`.
- Badge it in the UI: project list row, project dashboard header, and the briefing view.
  German copy, amber styling (the established "degraded/attention" colour).

Tests: `lib/adapters/registry.test.ts` (mock resolves), contract suite for the mock backend if
not already covered, `lib/pipeline/projects.test.ts` (mock allowed as primary; divergence rule).

Verify: `npx vitest run lib/adapters lib/pipeline tests/architecture.test.ts`

### T3 — Seed a demo project

New use-case `createDemoProject()` in `lib/pipeline`, exported from the barrel and pinned in
`tests/architecture.test.ts`.

- Project id is exactly `proj_demo` — fixed, not generated. A second call surfaces the existing
  `ProjectAlreadyExistsError` as a normal German `PipelineError`.
- Built with `createProject(...)` then a scripted `store.transaction(...)` sequence modelled on
  `tests/e2e/lifecycle.e2e.test.ts:77-281` — briefing blob + `recordBriefingImport`, two or
  three sources, several claims spanning **different terminal states** so the reviewer sees a
  realistic mix: at least one `confirmed`, one `pending_adjudication` (so the adjudication
  queue is non-empty and explorable), and one `contested`.
- **Every seeded history entry and project event uses actor `system:demo_seed`** (D1). The
  German `reason` strings should read as real workshop prose, not lorem ipsum.
- Content in German, self-evidently illustrative. Do not fabricate real-looking citations to
  real papers with fake findings — use clearly synthetic sources.
- Register must validate: `store.verify()` reports `ok: true`, and `tmb verify` on the seeded
  directory exits 0.

Tests: a `lib/pipeline` test asserting the seeded project verifies clean, has the expected
status mix, and that every seeded entry's actor is `system:demo_seed`.

Verify: `npx vitest run lib/pipeline tests/architecture.test.ts`

### T4 — Installation-level health + multi-step wizard

- New use-case `getInstallationBackendsHealth()` (D7), barrel + architecture test.
- New use-case to persist the workspace root (D5), barrel + architecture test. It must go
  through `lib/pipeline/setup.ts` — `app/**` must not import `lib/identity` directly.
- Rework `app/setup/` into the five steps of D4, reusing `app/components/ui.tsx` primitives
  (`inputClass`, `primaryButtonClass`, `ErrorBanner`, `SuccessBanner`) — do not invent new
  styling. Tailwind v4 utility classes only.
- Step 3 shows detected backends with the three-stage diagnosis and a login-probe button,
  reusing the existing `LoginProbeButton` pattern. If no backend is usable, the step must
  point clearly at the demo option rather than dead-ending.
- Step 5 offers "create first project" and "create demo project".
- Keep `app/setup/actions.ts`'s ordering rule: handle first, always.
- Empty `/projects` page gains a backend-health hint and a demo-project affordance.
- **Research guidance (D12).** The user researches the briefing outside this tool, and
  nothing currently says so. Add short, concrete German guidance at the two places a user
  actually needs it: the final wizard step, and the briefing-import page
  (`app/projects/[id]/briefing/`). It must cover: that the briefing is researched elsewhere
  (an agent CLI or a chat assistant) and imported here; that the briefing should cite its
  sources, because stage-1 verification checks quoted wording against the frozen document;
  that plain Markdown with one claim per paragraph extracts best; and that sources should be
  publicly retrievable (DOI/arXiv/URL) so auto-import can freeze them. Include a
  copy-to-clipboard prompt template the user can paste into their assistant. Keep it to a
  collapsible block — this is a hint, not a wall of text, and it must not push the actual
  import control below the fold.

Verify: `npx vitest run tests/first-run-setup.test.ts tests/architecture.test.ts lib/pipeline`

### T5 — Installation settings route (`/settings`)

- Edit the actor handle (D6), with German copy stating past entries are unchanged.
- Show installation health via `getInstallationBackendsHealth()`.
- Show the Unpaywall setting, reusing the existing read-only-when-env pattern.
- New use-case for updating the handle, barrel + architecture test. Reuse
  `isValidActorHandle`; reject invalid handles as a German `PipelineError`.
- Link to it from the layout header.

Verify: `npx vitest run tests/architecture.test.ts lib/pipeline`

### T6 — Node version check in the launcher

`bin/trustmebro.mjs`: check `process.versions.node` against 20.9 at startup, exit non-zero
with a clear message naming required and actual version. `bin/**` is outside the coverage
gate, so no test is required — but the check must be dependency-free and must not break the
existing port-scan/readiness/browser-open flow. Keep the file's language consistent
(it currently mixes English and German — make it German, matching the display tier).

Verify: `node bin/trustmebro.mjs --help`-equivalent smoke, plus `npm run check`.

### T7 — Rewrite documentation in release-ready product voice

Rewrite so the software reads as a shipped product, not a thesis artifact. Remove
evaluator/thesis/"Großer Beleg"/prototype framing and `TMB-nnn` ticket references from the
files listed below **only**.

In scope:

- `README.md` — full rewrite. Lead with what the software does for its user. The current
  opening ("Prototype of a verification workshop … Developed as part of the thesis") and the
  section heading "Installation and startup (evaluators, TMB-48)" are the clearest examples of
  what must go. Keep every instruction factually accurate — installation, prerequisites,
  first run, the demo option (new, from T3), and `tmb verify` (now actually shippable, T1).
- `cli/README.md`, `lib/adapters/README.md`, `lib/export/README.md`,
  `lib/pipeline/README.md`, `lib/register/README.md`
- `ARCHITECTURE.md` — keep the technical content; drop ticket-number framing.
- `.env.example` — prose only; variable names and semantics unchanged.

Out of scope (do not touch): `CLAUDE.md`, `AGENTS.md`, `review/SOFTWARE_REVIEW.md`,
`lib/register/projection/__fixtures__/briefing-golden.md`, `lib/adapters/prompts/**`,
and all source-comment `TMB-nnn` references.

Language: README and the `lib/*` READMEs are currently **English** — keep them English. The
in-app display tier stays German regardless.

Verify: `npm run format:check` (Prettier reflows Markdown — run `npm run format` if it fails),
then confirm no `TMB-` or thesis references remain in the in-scope files.

### T8 — Final gate

```
npm run check          # lint → format:check → typecheck → test:coverage
npm run build
npm pack --dry-run --json
```

All must pass. Push. **Do not open a pull request.** Write a final summary covering: what
landed, what did not and why, tarball size before/after, and anything that needed a judgement
call not covered by §2.

---

## 4. Out of scope — do not drift into these

TMB-53 bundles B, C and D. Specifically **not** in this run: SSE reconnect handling, error
boundaries (`app/error.tsx` / `not-found.tsx`), the `SUPPORT_LABELS` German violation,
progress counters, step rail / breadcrumbs, config-file versioning and migration, token/cost
accounting, the in-app trace viewer, prose chain-break reporting.

Also out of scope: review findings **S-02, S-04, S-08, S-09, S-10, S-11** (see D11), and
**S-03, S-06, S-12 — those are TMB-56**, not this run. **S-02 (repaired claim text never
reaches `briefing.md`) and S-03 (frozen HTML served as active same-origin content) are real
open High findings** — this run fixes neither and must not imply otherwise.

Automated in-app research (a `research` job kind that produces the briefing) is **not** in
this run — see D12. It is specced as TMB-55 and requires a thesis-appendix changelog entry.

One documentation-only exception: TMB-53 notes S-01 appears remediated by the `state_root`
commitment. Leave `review/SOFTWARE_REVIEW.md` alone — it is a dated artifact, and correcting
it is a separate decision.

---

## 5. Packaging addendum (binding for T1)

**Chosen approach: compile the CLI's dependency closure to JavaScript with `tsc` at pack time
and ship a plain-JS bin.** This is fixed — do not redesign it.

### Why not the alternatives

- **Reuse `.next/standalone`** — not viable. `output: "standalone"` traces only Next's own
  entrypoints. `cli/tmb.ts` is not one, so it is never emitted; the parts of `lib/register`
  that _are_ pulled in get inlined into opaque, hashed route bundles with no requirable
  `lib/register/index.js`. Making the CLI traceable would mean disguising it as a Next entry,
  coupling CLI shipping to Next internals and worsening the S-05 tracing bloat.
- **Make `tsx` a runtime dependency** — wrong direction. It pulls in `esbuild` with
  OS-specific native binaries, adds transpile cost on every invocation, inverts the repo's own
  convention, and still requires shipping `.ts` source.

### Dependency closure (traced, verified)

`cli/tmb.ts` → `cli/verify.ts` → the `lib/register` and `lib/export` barrels.
`lib/register/persistence/store.ts:4-5` imports `../../identity` for `resolveProjectDir`.
So the closure is `cli/**`, `lib/register/**`, `lib/export/**`, `lib/identity/**`, plus the
already-runtime deps `zod`, `fflate`, `proper-lockfile`. Nothing touches Next, React or `app/**`.

**Verified safe for CommonJS emit:** no `import.meta` and no top-level `await` anywhere in
that closure. (Checked before this spec was written — if you find one, stop and report rather
than switching module systems.)

### Concrete changes

**New `tsconfig.cli.json`** at the repo root — standalone, do **not** extend `tsconfig.json`
(its `moduleResolution: "bundler"` and `noEmit: true` are not emit-safe):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "strict": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": false,
    "incremental": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": [
    "cli/tmb.ts",
    "cli/verify.ts",
    "lib/register/**/*.ts",
    "lib/export/**/*.ts",
    "lib/identity/**/*.ts"
  ],
  "exclude": ["**/*.test.ts", "**/__fixtures__/**"]
}
```

CommonJS is deliberate: the source uses extensionless relative imports (`./persistence/store`),
which NodeNext/ESM output would require rewriting to `.js` everywhere — a source-wide edit for
no benefit. `rootDir: "."` mirrors the source layout into `dist/`, so relative imports keep
resolving.

**`cli/tmb.ts`**: add `#!/usr/bin/env node` as literal line 1. TypeScript preserves a leading
hashbang verbatim; Node strips it on load. Harmless on Windows (which uses a generated shim).

**New `scripts/build-cli.mjs`**, mirroring `scripts/package-build.mjs`'s style: `spawnSync`
`npx tsc -p tsconfig.cli.json` with `shell: process.platform === "win32"`, `stdio: "inherit"`,
propagating the exit code. Add `"build:cli": "node scripts/build-cli.mjs"` to scripts.

**`scripts/package-build.mjs`**: invoke `build-cli.mjs` as an additional step (independent of
the Next build) so `prepack` always produces `dist/`.

**`package.json`**:

```json
"bin": { "trustmebro": "bin/trustmebro.mjs", "tmb": "dist/cli/tmb.js" },
"files": ["bin", "dist/cli", "dist/lib", ".next/standalone", "README.md"]
```

List `dist/cli` and `dist/lib` explicitly rather than a bare `dist` so no `.tsbuildinfo`
leaks. `tmb` points straight at the compiled file — no wrapper needed, since `verify` is a
synchronous argv-in/exit-code-out command, unlike `trustmebro`'s port/browser orchestration.

**E2E tests** (`tests/e2e/lifecycle.e2e.test.ts:29,58-64`,
`tests/e2e/bundle.e2e.test.ts:34,38-53`): replace the `tsx` invocation with the compiled
artifact, and make each file self-sufficient — `npx vitest run <path>` bypasses npm lifecycle
hooks, so the build must happen in the test:

```ts
const compiledCli = path.join(repoRoot, "dist", "cli", "tmb.js");

beforeAll(() => {
  const build = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "build-cli.mjs")],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (build.status !== 0) throw new Error("CLI build failed");
});
```

Invoke `node dist/cli/tmb.js` directly, **not** the `tmb` shim — this sidesteps Windows
`.cmd`-shim quoting in tests while still exercising the artifact that ships. `incremental: true`
keeps the repeat-run recompile near-instant.

### Windows correctness

npm generates `.cmd`/`.ps1` wrappers for `bin.tmb` that call `node "<path>\dist\cli\tmb.js" %*`;
they do not read the shebang, so the hashbang only matters for POSIX direct-exec. Forward
slashes in the `bin` value are normalized by npm. No `chmod` step is needed — npm sets the
POSIX executable bit during install/pack, and Windows uses the shim.

### Verification (exact commands)

```
rm -rf dist && npm run build:cli && node dist/cli/tmb.js verify <a real project dir>
npx vitest run tests/e2e/lifecycle.e2e.test.ts tests/e2e/bundle.e2e.test.ts   # no manual build first
npm pack --dry-run --json          # dist/cli/tmb.js + dist/lib/** present; no .ts, no .tsbuildinfo
npm run check
```

Record the `npm pack --dry-run` file count and unpacked size **before and after** in the commit
message, so the S-05 baseline is not silently regressed.

**Full acceptance test** (do this if the environment allows): `npm pack`, then in a scratch
directory `npm install ../trustmebro-0.1.0.tgz && npx tmb verify <dir>`. That is literally the
bug being fixed. If a global install is not possible in the container, say so in the final
report rather than claiming the fix is verified.
</content>
