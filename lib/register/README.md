# lib/register

Domain core implementing the project file format: the zod schema for
`claims.json`, atomic persistence behind a single-writer lock, the
content-addressed blob store, the SHA-256 hash chain over RFC 8785
canonical JSON, the claim status machine, and the `briefing.md` projection.

This is the only place that writes `claims.json`. Everything else — the
pipeline, the web layer, the CLI — reaches the register through
`RegisterStore` transactions, which is what keeps the chain gapless and the
history append-only.
