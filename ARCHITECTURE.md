# TrustMeBro — Architecture

This document records the seams as implemented. The structural rules below
are not merely described: `tests/architecture.test.ts` enforces them, so a
change that erodes one fails the build rather than the review.

## Layers

```
lib/identity/   Foundation: sole reader of process.env and the stored
                first-run configuration; answers "current actor" and
                "current workspace root".
lib/register/   Domain core: claims.json, hash chain, status machine,
                blob store. Depends only on lib/identity.
lib/export/     Bundle core (.tmb): usable alongside the register, without
                a pipeline or adapter dependency (CLI-capable).
lib/adapters/   Backend interface and adapters (Claude CLI, Codex CLI,
                demonstration backend), orchestrator
                (retry/trace/concurrency), runtime ports (process runner,
                trace sink, concurrency gate).
lib/pipeline/   Use cases invoked by the web UI; job runner.
app/            Next.js UI; imports only the public pipeline barrel.
cli/            The standalone `tmb` command (verify), written against the
                register and export barrels only. Compiled to plain
                JavaScript at pack time and shipped as a bin, so it runs
                from an installed package with no build tooling present.
proxy.ts        First-run gate: redirects every request to /setup until
                setup is complete (Next 16 proxy, Node runtime).
```

## Identity and workspace

`lib/identity` is the single place that answers **who** is acting and
**where** projects live:

- `getCurrentActor(): "human:<handle>"` — actor identifier of every
  history entry.
- `getWorkspaceRoot(): string` — absolute workspace root.
- `resolveProjectDir(projectId): string` — the sole path construction for
  project directories (validates the project id, excludes traversal).

Configuration resolution **per field**: environment variable → stored
configuration file → code default. The actor handle deliberately has
**no** code default: if it is configured nowhere, `loadIdentityConfig()`
throws `IdentityNotConfiguredError`, and `proxy.ts` redirects to the
first-run setup at `/setup`. The file lives outside the workspace
(default `~/.trustmebro/config.json`, override `TMB_CONFIG_PATH`),
because the workspace location itself is one of its answers. It is
written exclusively through the writers in `lib/identity` (atomic; the
second sanctioned raw write site alongside the register's atomic-write
helper — `lib/register` depends on `lib/identity`, so the reverse import
would be a layering inversion).

The web layer never reaches into `lib/identity` directly. Reading and
changing installation settings — actor handle, workspace root, Unpaywall
address — goes through use-cases in `lib/pipeline/setup.ts`, which also
carry the rules attached to them: an env-provided value is refused rather
than written where the environment would immediately override it, and the
workspace root is refused once projects exist, because moving it would
orphan them.

Enforced by architecture tests: `process.env` only in `lib/identity`;
`getWorkspaceRoot`/`resolveProjectDir` only at the fixed call sites
(register store, project list, bundle import, setup).

## Operational robustness

- **Preflight** (`lib/adapters/health/`): three check stages per backend —
  CLI on the search path, version compatible, login functional. Stages
  1+2 are free (a `--version` spawn via the sanctioned runner) and run on
  every page load and run start; stage 3 is a deliberately manual test
  call (costs quota) with an in-process cache. Extraction and the
  relevance check refuse to start against a primary backend that is not
  ready; the verification cascade keeps running (stage 1 stays usable)
  and only skips the LLM stages per claim.
- **Runtime errors**: error classes and reactions are tabulated in
  `lib/adapters/README.md` ("Error classes and reactions"). User-initiated
  pause/cancel is a cooperative primitive of the job runner (between
  items, never mid CLI call); since state is persisted per claim, every
  abort is a resumable state.

## Extension path: multi-user operation

The application is consistently single-user. The later multi-user
architecture is a documented extension path across four seams —
designed, spot-proven, not built:

1. **Backend interface** (`lib/adapters/core/contracts.ts`, `Backend`):
   deliberately free of CLI vocabulary. The API-backend spike
   (`createAnthropicApiBackend`, the Anthropic Messages API behind its
   own HTTP port analogous to the process runner) is the existence
   proof: an API backend is just another adapter and passes the same
   contract test (`lib/adapters/__fixtures__/contract-suite.ts`) as the
   CLI adapters — without any change to the pipeline or register. It is
   double-gated (`TMB_ENABLE_API_BACKEND=1` + `ANTHROPIC_API_KEY`),
   implements only the attribution-judgment job kind, and is therefore
   selectable only as a secondary backend; the status page checks it via
   flag/key instead of search path/version. Without a key, the
   application runs unchanged.
2. **Identity** (`lib/identity`): as above — a login would only replace
   the resolution inside `loadIdentityConfig` (session-bound instead of
   file-bound); all callers keep their signatures.
3. **Workspace abstraction** (`resolveProjectDir`): today a flat root;
   multi-user operation means one root per user inside exactly this one
   function — the architecture test guarantees it is the sole path
   authority.
4. **Global CLI queue** (`getGlobalConcurrencyGate`): today a
   process-wide semaphore protecting the quota of the single subscription;
   multi-user operation replaces the singleton with a per-tenant capacity
   behind the same `ConcurrencyGate` port.

The demonstration backend is the opposite case and deliberately ungated:
it answers every job kind with canned, schema-valid output, spawns no
process and needs no account, so the application is usable on a machine
with nothing installed. Its isolation is provenance rather than
prohibition — seeded entries carry a `demo_seed` actor, which is part of
the hashed history and therefore survives export and `tmb verify`.

**Licensing rationale for the single-user scope:** the default backends
are agent CLIs with subscription logins; their terms of service tie the
quota to the account holder's personal use. A server that issues CLI
calls on behalf of multiple users would operate the subscription as a
shared service and leave the permitted scope. Compliant multi-user
operation only works via token-billed API integrations — exactly the
path seam 1 keeps open with the spike. In addition, login and tenant
separation (seams 2/3) as well as access control and process isolation
would be required; both are designed but deliberately out of scope for
single-user operation.
