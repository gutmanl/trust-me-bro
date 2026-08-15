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
assertion naming the gap:

1. **`normalizeArxivId` accepts DOIs whose suffix embeds a year-like
   number.** Two of the 83 real DOIs in the research lists match:
   `10.1109/eScience65000.2025.00093` → `2025.00093`. Not reachable from the
   reference scan (which requires an explicit `arXiv:` prefix) but reachable
   from a manual capture where a human picks "arXiv" and pastes a DOI.
   Pinned in `identifier-corpus.test.ts`.

2. **The "proven PDF" guard never looks at the bytes.** `expectedExt`
   compares the server's declared `Content-Type` against `pdf`; there is no
   `%PDF-` magic-number check and no requirement that `unpdf` parse the file
   before it is frozen. A host that mislabels an HTML paywall as
   `application/pdf` gets it stored as a `.pdf` blob. What limits the damage
   is the layer behind it — text extraction fails, so stage 1 can never prove
   a quote against it — which is the right outcome reached by accident.
   Pinned in `tests/e2e/corpus-document-integrity.e2e.test.ts`.

3. **The identity cross-check only fires for citations that carry a title.**
   The regex channel reads identifiers but no titles, so a candidate's title
   comes from its footnote definition or from the LLM channel. A briefing
   that cites inline (`(Title, doi:…)`) rather than by footnote produces
   candidates with no title, and the preventive hallucinated-identifier check
   returns without comparing anything. This is why `scenarios.ts` uses
   footnote citations — and why a briefing in the other style exercises
   strictly less of the scan.

## Adding a scenario

1. Add the source and its expected answers to `scenarios.ts`.
2. Add the synthetic cassettes to `scripts/seed-corpus.ts`, building query
   strings with the same helpers the pipeline uses rather than transcribing
   them.
3. Run `npm run corpus:seed`, then write the spec.
4. Record the real answers when you next have network:
   `npm run corpus:record -- --http`.
