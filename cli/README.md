# cli

Standalone command-line tools, independent of the web application.
`tmb verify` re-runs the hash-chain verification for a project
directory or a `.tmb` export bundle (built with TMB-13, extended in
TMB-42 with bundle mode and blob-integrity checking; operationalizes
the Git-independent verifiability of the file format). Bundles are
additionally checked against their manifest — per-file checksums and
the committed chain head — entirely in memory. Depends only on
`lib/register` and `lib/export` (architecture-guarded).

Run via `npm run tmb -- verify <project-dir|bundle.tmb>`.
