# lib/register

Domain core implementing the project file format (thesis appendix
"Entwurf des Projektdateiformats", normative): zod schema for
`claims.json`, atomic persistence with single-writer lock, content-
addressed blob store, SHA-256 hash chain (RFC 8785), status machine,
and the `briefing.md` projection. The only place that writes
`claims.json`. Built in epic TMB-1 (tickets TMB-10 … TMB-15).
