# Security

TrustMeBro is a single-user application. Its server binds to the loopback
interface only and is not designed to be exposed on a network.

If you find a vulnerability — for example a way to forge or silently alter
register history so that `tmb verify` still passes, a path traversal out of
the workspace, or a way to reach the server from another host — please report
it privately through GitHub's "Report a vulnerability" function on this
repository rather than in a public issue. Only the latest release is
supported.
