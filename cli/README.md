# cli

The standalone `tmb` command, independent of the web application.

`tmb verify <project-dir|bundle.tmb>` re-runs the integrity check of a
project directory or a `.tmb` export bundle: the SHA-256 hash chain, the
content state against the state root committed by the last entry, and every
stored document against its recorded checksum. Bundles are additionally
checked against their manifest — per-file checksums and the committed chain
head — entirely in memory, without unpacking to disk first.

This is what makes the file format verifiable without Git and without this
application: a recipient can check a bundle without trusting, or even
installing, whatever produced it. The command exits `0` when everything
holds, `1` when it does not, and `2` on a usage error, so it fits into a
script or a CI step. `tmb --help` prints the usage, `tmb --version` the
package version. A target that is a `claims.json` file rather than a
directory verifies the containing project directory — the register file
alone would leave the blobs unchecked.

Depends only on `lib/register` and `lib/export`, which is
architecture-guarded — that narrow closure is why it can be compiled to
plain JavaScript at pack time and shipped as a `bin`, with no build tooling
required on the installing machine.

Installed packages expose it as `tmb`. From a checkout, run it via
`npm run tmb -- verify <project-dir|bundle.tmb>`, or build it once with
`npm run build:cli` and call `node dist/cli/tmb.js verify <target>`.
