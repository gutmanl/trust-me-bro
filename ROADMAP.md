# Roadmap

What is planned next, roughly in order. Nothing here is scheduled; the list
exists so that the work ahead is visible. Items graduate to GitHub issues when
they are started.

## Trust and export

- **Signed bundles.** `tmb verify` proves a `.tmb` bundle is internally
  consistent, but a bundle is not signed, so whoever holds it could rebuild
  the whole chain. Add an optional signature over the chain head and manifest,
  and have `tmb verify` report whether and by whom a bundle is signed.
- **Anchoring the chain head.** A way to record the newest entry hash outside
  the project directory (a file, a commit, a timestamping service), so a later
  rewrite of the full history becomes detectable.
- **Tagged releases with attached tarballs.** Releases exist as commits
  (`release: v0.4.0`) but not as git tags or GitHub releases; the tarball has
  to be built from a checkout. Add a release workflow that packs and attaches
  it.

## Backends

- **API backend for every job kind.** The token-billed API adapter is a spike
  that implements only the attribution judgment and is selectable only as a
  secondary backend. Extend it to extraction, relevance, calibration and
  repair, and take it through the same contract suite as the CLI adapters.
- **More than one API provider** behind the same `Backend` port.

## Sources

- **Source types beyond PDF.** Auto-import stores only what it has proven to
  be a real PDF. Frozen HTML and plain-text sources need their own proof of
  what was captured before stage 1 may check wording against them.
- **Manually supplied documents for paywalled sources**, with the same
  hashing and provenance as fetched ones, as a first-class flow.

## Interface

- **English interface.** The display tier is German by design and is already
  separated from the English enum values by label maps. Turn those maps into
  locale tables and add English.
- **Keyboard-first adjudication** for working through a long queue.

## Multi-user operation

Deliberately not built. The four seams it would go through — backend
interface, identity, workspace resolution, concurrency gate — are described
in [ARCHITECTURE.md](ARCHITECTURE.md). It depends on the API backend above,
because subscription-based agent CLIs may not be operated as a shared
service.

## Housekeeping

- Work through the remaining findings of the internal review in
  [review/SOFTWARE_REVIEW.md](review/SOFTWARE_REVIEW.md) and mark each one as
  fixed, accepted or open.
- Keep raising the coverage thresholds in `vitest.config.ts` as coverage
  grows.
