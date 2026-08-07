# lib/pipeline

Use-case layer between the web routes and the domain core: project and
workspace management, briefing import, source capture with frozen
snapshots, full-text extraction and the claim extraction run (epic
TMB-3). Verification stages 1–3, divergence rule and repair loop follow
in epic TMB-4.

`app/` imports exclusively from the barrel (`index.ts`); every register
mutation goes through `RegisterStore` transactions, every LLM call
through the adapter orchestrator, every network access through the
`HttpFetcher` port.

## Layout

- `projects.ts` — createProject / listProjects / summaries; the only
  place that walks the workspace root.
- `briefing.ts` — one-time briefing import (frozen original blob +
  `briefing_imported` chain event).
- `ids.ts` — pure id minting (`proj_`, `src_`, `clm_`, per-claim `ev_`);
  client-safe (no Node APIs).
- `sources/` — capture use-case: `identifiers.ts` (DOI/arXiv/URL
  normalization, pure), `csl.ts` (CSL-JSON core, citations, F4 strip),
  `resolve.ts` (doi.org content negotiation, arXiv Atom), `capture.ts`
  (snapshot freeze incl. full text, `source_set_frozen`),
  `fetch-port.ts` + `node-http-fetcher.ts` (the single sanctioned
  network call site, architecture-guarded).
- `fulltext/` — deterministic snapshot → text extraction (unpdf,
  Readability + linkedom); failures land in
  `custom.snapshot.text_extraction_error`, never block a capture.
- `text/` — pure normal form for verbatim-quote search, shared with
  TMB-4's stage 1 (architecture-guarded pure directory).
- `runs/` — minimal in-process job runner: one active run per project
  (single-writer), cross-project concurrent up to the adapter layer's
  global CLI gate, in-memory progress events with replay for SSE.
- `extraction/` — the extraction run: `batch_run_started/completed`
  bracket, one-transaction bundle apply (register rejection = zero
  claims), state derived purely from the register (`derive-state.ts`).
- `errors.ts` — typed taxonomy the web layer maps to user messages.
