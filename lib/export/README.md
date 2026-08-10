# lib/export

Bundle core of the `.tmb` export format: in-memory ZIP
pack/unpack (fflate, confined to `zip.ts`), the manifest with per-file
SHA-256 checksums and chain-head commitment, blob-reference collection,
the shared bundle verification and the atomic bundle materializer for
import. Domain core beside `lib/register`: no `lib/pipeline` or
`lib/adapters` imports, so the standalone CLI can use it without the
web application. The derived-export builders (references.csl.json,
prov.jsonld, traces.json) live in `lib/pipeline/export` — the bundle
receives them as ready files.
