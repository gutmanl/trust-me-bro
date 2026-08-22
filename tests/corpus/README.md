# The real-world corpus

Every network- and LLM-facing test in this repository used to run against
fixtures written by hand. That is a closed loop: the Crossref and arXiv
response shapes, the LLM output shapes, and the similarity thresholds tuned
against them were all authored by the same people who wrote the code that
consumes them. This directory is the way out of it — recorded interactions
with the real services, replayed deterministically.

## Layout

| Path                    | What it is                                                   |
| ----------------------- | ------------------------------------------------------------ |
| `identifiers/`          | Real data from the thesis's literature search — see below    |
| `http/<key>.json`       | One recorded HTTP interaction, keyed by canonical request    |
| `llm/<kind>/<key>.json` | One recorded LLM answer, keyed by job kind + canonical input |
| `documents.json`        | Hash manifest of large binaries                              |
| `documents-seed/`       | Small committed stand-ins for those binaries                 |
| `documents/`            | The real binaries — **gitignored**, fetched on demand        |
| `cassette.ts`           | Cassette format and key derivation                           |
| `cassette-fetcher.ts`   | `HttpFetcher` that replays `http/`                           |
| `replay-backend.ts`     | `Backend` that replays `llm/`                                |
| `scenarios.ts`          | What the specs test against — the briefing and its citations |
| `llm-seed.ts`           | Authored LLM answers, used until real ones are recorded      |
| `harness.ts`            | Workspace, orchestrator and project setup for the specs      |
| `verdict-fixtures.json` | Real claims frozen out of the real registers — see below     |
| `verdict-comparison/`   | Output of the PROMPT-05 ship gate — see its own README       |

## `verdict-fixtures.json` — real claims, not authored ones

This is the fixture corpus the PROMPT-05 ship gate runs against: at least 30
claims with their claim type, their briefing anchor, and per evidence the source
id, source type, locator and verbatim excerpt — exactly the fields a job input
needs, and nothing else.

**It is real run output, not authored data.** Every claim in it was extracted,
attributed and calibrated by real `claude` / `codex` runs against real papers, and
each one carries the verdict those runs actually recorded as its v1.1.0 ground
truth. It exists for the same reason the rest of this directory does: authoring 30
claims to test the code that judges claims is the closed loop the first paragraph
of this README describes.

**Which machine it came from:** it cannot be produced anywhere else. It is frozen
out of the gitignored, machine-local `workspace/` directory on the operator's own
machine by `scripts/extract-verdict-fixtures.ts`, which takes that directory as
its first argument. A fresh clone, CI and a cloud session have no registers to
freeze, so re-generating it there is neither possible nor attempted.

The extraction emits only the enumerated job-input fields — no actor handles, no
chain hashes, no blob paths, no history entries, no complaint text. Redaction is
by construction rather than by review, and a human read the excerpts before the
file was first committed.

**The frozen source blobs those excerpts came from are deliberately not in the
repo.** That is fine rather than a gap: attribution judges strictly against the
`verbatim_excerpt`, which travels in the fixture; the optional read of the frozen
document is a bonus, not a requirement.

Three borderline proxies are recorded per claim as explicit booleans — a
`weakened` or `pending_adjudication` calibration result, a mechanical rubric
evaluation of not-met (so the cap fired), and evidence carrying more than one
judgment (so the second-opinion rule fired). "Borderline cases are included" is
therefore a checkable fact about the file rather than a claim in a comment.

Re-generate with:

```bash
npx tsx scripts/extract-verdict-fixtures.ts <workspace-root>
```

It sorts by claim id, so a re-extraction produces a readable diff. It refuses to
write a corpus below 30 claims or one with no borderline claim — do not lower N
and do not author substitute claims to reach it.

## Two provenance states

Every cassette declares where it came from:

- **`synthetic`** — authored in-repo, shaped after the response the
  production parser reads. Regenerate with `npm run corpus:seed`.
- **`recorded`** — captured from the live service by `npm run corpus:record`,
  which overwrites the synthetic file in place and flips the flag.

The specs do not change between the two states. `corpus-integrity.test.ts`
prints the split on every run, so "how real is this corpus?" is a question
the suite answers rather than a claim in a comment.

## Recording it yourself

```bash
# HTTP only — needs outbound access to doi.org, export.arxiv.org,
# api.crossref.org, and optionally api.unpaywall.org.
npm run corpus:record -- --http

# Also record real LLM answers. Needs `claude` on PATH and logged in.
# This spends subscription quota.
npm run corpus:record -- --http --llm

# Download the hash-pinned PDFs (documents/ is gitignored).
npm run corpus:fetch
```

`record-corpus.ts` does not issue a hand-written list of URLs. It runs the
same scenario the specs run, through the same use-cases, with the real
`nodeHttpFetcher` wrapped in a recorder — so every request the pipeline makes
is captured under exactly the key the replay looks up. A cassette keyed on a
URL the code never requests would be a cassette that silently does nothing.

Redaction happens on the way in: Unpaywall's required contact address, and
anything named `api_key`/`token`/`key`, is replaced before a file is written.
A guard test re-checks that.

## The identifier data is real today

`identifiers/` was copied from the companion thesis repository and needs no
recording:

- `ids_<block>_<system>.txt` — 675 lines of identifiers that ChatGPT Deep
  Research and Claude Research returned for the six thematic blocks of the
  literature review.
- `korpus-manifest.csv` — the frozen corpus: 33 documents with SHA-256 and
  page counts.
- `exclusion-log-2026-07-26.md` — the archived log of identifiers that did
  not resolve.
- `anchor-papers.txt` — the eight snowballing anchors.

One correction worth carrying, because the obvious reading of the exclusion
log is wrong: those identifiers are **not** hallucinations. The thesis's
methodology appendix reports that every entry traced back to a defect in the
ingest tool — arXiv patterns wrongly extracted out of DOI strings — and that
after the fix, the rate of genuinely fabricated references was zero. So the
log is ground truth for a _parsing_ failure, which is what
`identifier-corpus.test.ts` tests it as.

## Known gaps this corpus exposed

Pinned as current behaviour rather than fixed, each with a comment at the
assertion naming the gap. All three have since been closed (15.08.2026) and
their tests now assert the fix instead:

1. **`normalizeArxivId` accepted DOIs whose suffix embeds a year-like
   number.** ~~FIXED~~ — two of the 83 real DOIs in the research lists
   matched: `10.1109/eScience65000.2025.00093` → `2025.00093`. Never
   reachable from the reference scan (which requires an explicit `arXiv:`
   prefix) but reachable from a manual capture where a human picks "arXiv"
   and pastes a DOI. The pattern is anchored now and the three accepted forms
   (bare, `arXiv:`-prefixed, arxiv.org URL) are recognized structurally, so
   nothing is mined out of a longer string. `identifier-corpus.test.ts` now
   asserts that NO real DOI yields an id, so a third would be noticed.

2. **The "proven PDF" guard never looked at the bytes.** ~~FIXED~~ —
   `expectedExt` compared only the server's declared `Content-Type`, so a host
   that mislabelled an HTML paywall as `application/pdf` got it stored as a
   `.pdf` blob; the damage was limited only by text extraction failing behind
   it, which is the right outcome reached by accident. `acquireDocument` now
   also requires the `%PDF-` signature within the first 1024 bytes of anything
   frozen under a `.pdf` path, whoever supplied the document. Asserted in
   `tests/e2e/corpus-document-integrity.e2e.test.ts`.

3. **The identity cross-check only fired for citations that carry a title.**
   ~~FIXED~~ — the regex channel reads identifiers but no titles, so a
   candidate's title came from its footnote definition, and prompt v1.0.0
   told the model not to report a citation the regex channel had already
   found. A briefing citing inline (`(Title, doi:…)`) produced candidates
   with no title, and the preventive hallucinated-identifier check returned
   without comparing anything — it was silently a footnote-only feature.
   Prompt v1.1.0 reports those citations with their bibliographic detail, the
   dedup keeps a re-report that echoes a known identifier so it merges rather
   than duplicating, and the check runs on merged seeds. `scenarios.ts` now
   carries one misattribution of EACH citation style — the fixture's
   footnote-only design is what hid this.

## Adding a scenario

1. Add the source and its expected answers to `scenarios.ts`.
2. Add the synthetic cassettes to `scripts/seed-corpus.ts`, building query
   strings with the same helpers the pipeline uses rather than transcribing
   them.
3. Run `npm run corpus:seed`, then write the spec.
4. Record the real answers when you next have network:
   `npm run corpus:record -- --http`.
