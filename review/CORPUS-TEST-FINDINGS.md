# Findings from the corpus-driven end-to-end suite

What running the pipeline against real identifiers and realistic service
responses turned up. Each item was **pinned as current behaviour** in a test
with a comment naming the gap — nothing was fixed as part of writing them, so
`npm run check` stayed green and the decision on each was the author's.

Findings 1, 2 and 3 have since been fixed (15.08.2026); their tests now assert
the guard rather than the gap. Finding 4 was closed by the suite itself and is
kept as a note on test design.

Ordered by how much of the product's central claim they touch.

---

## 1. The identity cross-check is unreachable for parenthetical citations — FIXED (15.08.2026)

**Severity was: high — it silently disabled the thesis's central guard.**

**Resolution.** The title now reaches the check, from the channel that can
actually read one. Prompt `reference_parse` v1.1.0 asks the model to report
the citations the regex channel already found — v1.0.0 told it to stay silent
about exactly those — with the bibliographic detail the regex channel cannot
read and the identifier echoed back, so the report joins its regex seed by
identity key and the merge puts the cited title on the identifier. The
cross-check itself is unchanged.

Three supporting changes, because the title alone was not enough:

- `dropAlreadyIdentified` keeps a re-report whose OWN identifier is one the
  regex channel already found. That one merges rather than duplicating; the
  duplicate the module exists to stop is the other shape, the same work under
  a _different_ identifier, which no merge collapses.
- The cross-check runs on MERGED seeds now (`mergeSeeds`, extracted from
  `mergeCandidates`). Unmerged, the titleless regex seed and the titled LLM
  seed would each resolve the identifier over the network while only one
  could compare anything.
- The merge carries `identity_conflict` / `identity_conflict_note` /
  `alternate_title_match` from the losing seed, as the finding's note below
  warned. Belt-and-braces after the reorder, but a verdict silently lost to a
  merge would re-admit a hallucinated identifier to auto-capture.
- An echoed identifier is canonicalized on both sides of the comparison and
  on its way into a seed. Review caught this: an arXiv id is detected as
  `arXiv:2601.20727` but stored bare, so a raw string comparison recognized
  no arXiv echo at all — it was dropped instead of merged, and the fix would
  have shipped working for DOIs and silently broken for arXiv, which the
  DOI-only corpus fixture could not have noticed. Pinned in
  `dedup-identified.test.ts` across all four surface forms.

Two things found while fixing it, both now closed:

- **The verdict was never shown.** `identity_conflict_note` and
  `alternate_title_match` appeared nowhere in `app/`, so even the footnote
  path that worked produced only a silently unchecked row — while
  `review.ts` and `identity-crosscheck.ts` both promise in comments that "the
  human chooses between the two hypotheses". The candidate row now renders
  the note and the competing work.
- **The fixture agreed with the bug.** `scenarios.ts` cited every source by
  footnote, which is why this survived. It now carries one misattribution of
  each style, and `corpus-pipeline.e2e.test.ts` asserts both.

The remaining limit is worth stating: the check's reach depends on the LLM
channel. With the backend down the scan degrades to regex-only and an inline
citation still has no title, so the guard still cannot run. That is the same
fail-open the rest of the scan uses, but it is a fail-open on the thesis's
central guard.

The original finding follows, as recorded.

---

`crossCheckIdentifiedSeed` (`lib/pipeline/sources/reference-scan/identity-crosscheck.ts:30-37`)
returns immediately unless the candidate seed carries a `title`:

```ts
if (
  (seed.method !== "doi" && seed.method !== "arxiv") ||
  !identifier ||
  !seed.title
) {
  return seed;
}
```

The regex channel reads identifiers but never titles, so a seed's title can
only come from two places: a **footnote definition** whose marker appears
next to the identifier (`run-reference-scan.ts:193-206`), or the **LLM
channel**. But an LLM-parsed citation that re-reports a paragraph already
carrying an identifier is dropped as a duplicate by `dropAlreadyIdentified`
(`run-reference-scan.ts:254-258`) — correctly, since it _is_ the same
citation.

The consequence: a briefing that cites inline —

```
… liegt eine eigene Arbeit vor (Claim-Level Verification …, doi:10.18653/v1/2024.inlg-main.35).
```

— produces a candidate with an identifier, no title, and **no cross-check at
all**. The hallucinated identifier passes through as a clean candidate and is
pre-selected for auto-capture. Only the footnote style —

```
… liegt eine eigene Arbeit vor.[^2]

[^2]: Claim-Level Verification … . 10.18653/v1/2024.inlg-main.35
```

— reaches the check. Both styles occur in real deep-research output; the
footnote style is what Elicit and Perplexity emit, and that is presumably why
it works.

I verified both paths. With footnotes the check fires and reads exactly as
intended (19 % title match, candidate withheld from auto-capture,
`identity_conflict_note` naming the work the DOI really points at). With
parenthetical citations nothing happens at all.

**Worth considering:** derive a title for identified regex seeds from the
sentence around the identifier, or let an LLM-parsed duplicate contribute its
title to the existing candidate instead of being dropped whole. Note that
`mergeCandidates` (`candidate.ts:130-170`) already merges `title`/`authors`/
`year` across seeds but does **not** carry `identity_conflict` across — so if
the duplicate were kept, a verdict computed on it would still be dropped by
the merge. Both halves need changing together.

Pinned in `tests/corpus/scenarios.ts` (the briefing uses footnotes, with the
reason in the doc comment) and asserted in
`tests/e2e/corpus-pipeline.e2e.test.ts`.

---

## 2. "Proven PDF" never looks at the bytes — FIXED (15.08.2026)

**Severity was: medium — bounded by a second layer, but the corpus could still
be poisoned.**

**Resolution.** `acquireDocument` now requires the `%PDF-` signature within the
first 1024 bytes of any document about to be frozen under a `.pdf` blob path.
The check is keyed on the RESOLVED extension rather than on `expectedExt`, so
it covers every path into the store — the auto-import URL the app derived
itself, a URL or upload a user vouched for, a correction, and a revision,
which sets no `expectedExt` at all. The window matches the tolerance pdf.js
applies, so the guard rejects exactly what the extraction could never parse
and no genuine paper beyond it; it deliberately stops at the signature rather
than demanding a successful `unpdf` parse, because a scanned paper without a
text layer is a real PDF and must stay capturable (TMB-24). The failure now
lands in front of the reviewer as a capture failure instead of as a source
whose text extraction happens to have failed.

The original finding follows, as recorded.

---

`CLAUDE.md` says auto-import "may only store a document it has proven is a
real PDF". The proof is `expectedExt` (`lib/pipeline/sources/document.ts:103-108`),
which compares the server's declared `Content-Type` — falling back to the
URL's filename extension — against `"pdf"`. There is no `%PDF-` magic-number
check, and no requirement that `unpdf` parse the file before it is frozen.

A host that labels an HTML paywall `application/pdf` walks straight past it.
I confirmed this end to end: the paywall HTML is stored as a `.pdf` blob in
the content-addressed store, and the source is created.

What limits the damage is the layer behind: text extraction fails, so the
snapshot carries `text_extraction_error` and no text blob, and stage 1's
wording proof can therefore never pass against it. The claim reaches a human
instead of being auto-confirmed against a sales page — the right outcome,
reached by accident rather than by the check meant to reach it. The residual
cost is a corpus entry that looks captured and is not, travelling into
`briefing.md` and the export bundle.

**Worth considering:** a four-byte `%PDF` check in `acquireDocument` when
`expectedExt === "pdf"`. Cheap, and it moves the failure to where the message
already exists.

Pinned in `tests/e2e/corpus-document-integrity.e2e.test.ts`.

---

## 3. `normalizeArxivId` accepts DOIs whose suffix embeds a year-like number — FIXED (15.08.2026)

**Severity was: low — not reachable unattended, but it is the thesis's own bug.**

**Resolution.** The pattern is anchored (`/^(\d{4}\.\d{4,5})(v\d+)?$/`) and
`normalizeArxivId` now recognizes its three documented forms structurally —
bare id, `arXiv:`-prefixed id, arxiv.org URL — instead of scanning the input
for a number of that shape. Note the anchor ALONE would have been wrong: the
suggestion below assumes every caller passes a bare or already-extracted id,
but stage 1's live source check (`verification/stage1/source-check.ts`) hands
in a source's stored URL whole, and `capture.ts` accepts a pasted resolver
URL. Both are read explicitly now, the id taken from the last path segment of
an arxiv.org host and nowhere else. `identifier-corpus.test.ts` asserts that
none of the real DOIs yields an id, rather than pinning the two known ones, so
a third would be caught.

The original finding follows, as recorded.

---

`ARXIV_ID_PATTERN = /\b(\d{4}\.\d{4,5})(v\d+)?\b/` (`lib/pipeline/sources/identifiers.ts:8`)
matches anywhere in the input. Run against the 675 real identifiers two
research systems produced for the thesis, two of the 83 DOIs match:

```
10.1109/eScience65000.2025.00093  →  2025.00093
10.1109/ESEM64174.2025.00053      →  2025.00053
```

This is the same shape of defect the thesis's own `zotero_ingest.py` had —
the one its methodology appendix reports as the cause of every entry in the
exclusion log, and the reason the apparent hallucination rate looked non-zero
until it was fixed.

It is **not** reachable from the reference scan, which requires an explicit
`arXiv:` prefix or an arxiv.org URL (asserted against all 83 real DOIs). It
**is** reachable from a manual capture where a human selects "arXiv" in the
form and pastes a DOI: the work-item guard
(`lib/pipeline/sources/work-items/queue.ts:64`) accepts it, and the capture
then resolves a number arXiv has never issued.

**Worth considering:** anchoring the pattern (`/^(\d{4}\.\d{4,5})(v\d+)?$/`
after stripping a leading `arXiv:`), since every caller passes either a bare
id or an already-extracted match.

Pinned in `tests/corpus/identifier-corpus.test.ts`, which asserts the exact
list of two so it cannot grow unnoticed.

---

## 4. A missing cassette is indistinguishable from a service outage

**Severity: low, and it is about test design rather than the product — but
worth knowing, because it made a spec pass for the wrong reason during
development.**

Crossref's `tryFetch` (`crossref.ts:120-129`) and the whole of
`fetchUnpaywallPdfUrl` swallow every fetch error by contract, to stay
fail-open. That is correct behaviour. It also means a replay fetcher that
throws on a missing recording has its error absorbed and reinterpreted as
"the service had nothing to say" — and an assertion like "no document url was
derived" then passes while testing something else entirely.

This bit during development: the Crossref cassettes were recorded without the
`Accept: application/json` header the code sends, so every Crossref lookup
missed, and the spec's "no PDF url" expectation went green.

The cassette fetcher now records misses separately and every spec that
fetches asserts `fetcher.misses()` is empty, before any other assertion.

---

## Note on the corpus's own provenance

`tests/corpus/identifiers/` is real data, copied from the thesis repository.
The cassettes were **synthetic** when this document was written — shaped after
the responses the production parsers read, because that environment had no
outbound access to doi.org, arXiv, Crossref or Unpaywall.

They were recorded for real on 16.08.2026, from a machine that does:

```
corpus: 12/12 cassettes recorded from live services (11 HTTP, 1 LLM),
        1/2 documents hash-pinned from a real recording.
```

Every cassette on disk is a live recording. One synthetic cassette was
DELETED rather than recorded: Unpaywall for the inline-cited DOI. The real
Springer record carries an exact application/pdf link, so the derivation
stops at crossref_pdf and nothing ever requests that cassette — and its
invented body ("closed access") contradicted reality, the paper being CC-BY.
The seed script now mirrors the real link and no longer generates it. The
second unrecorded document is the committed stand-in PDF, which is generated
by construction.

**Recording changed four facts the synthetic corpus had invented**, which is
the entire argument for doing it:

- Both misattributed DOIs resolved to different works than the fixtures
  claimed. `10.18653/…inlg-main.35` is "Towards Fine-Grained Citation
  Evaluation in Generated Text", not the Willemsen/Skantze paper the fixture
  named; `10.1007/s10664-023-10288-w` is Bjarnason et al. on software
  selection. Both misattributions still hold — cited and resolved titles are
  unrelated works either way — so only the recorded titles moved.
- The quoted sentence stage 1 proves did not exist. `QUOTE_PRESENT` was an
  invented line about a median reconstruction time falling from 42 to 19
  minutes, absent from the paper the corpus cites. It is now a sentence
  copied out of the real work — and the real extraction model, given the real
  PDF, independently cited that same sentence, at page 7 §4.4.
- Crossref's record for the ACL DOI carries an EMPTY `link[]`. The synthetic
  fixture had invented a PDF entry there, so the spec exercised the
  `crossref_pdf` branch; the real chain falls through to Unpaywall, which is
  the branch that actually knows about open access.
- The arXiv PDF's sha256 matches the hash pinned from the thesis corpus
  exactly, which is the one fixture assumption recording confirmed rather
  than corrected.

Findings 1–3 did not depend on any of that: they are properties of the code's
own control flow and of the real identifier data, and all three were found
with the corpus in its synthetic state.
