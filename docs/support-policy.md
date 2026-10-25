# Support policy

The preview targets public GitHub repositories and private repositories accessible
to the supplied read-only token. Node.js `>=20.17.0` is supported; CI exercises
Node 20 and 22 on Linux. Windows is best effort and macOS is not covered by CI.
For private repositories, source files are read through the authenticated GitHub
contents API; each selected file costs one API request. Without a token, private
source contents remain unknown and are not fetched through the public raw host.
Large private repositories should use `--no-scan` or a bounded scan configuration.
Supported ecosystems include npm, PyPI/Python, Cargo/crates.io, and Go, with
language/build coverage bounded by the readers. GitHub-only features include the
repository collector, releases, history, Action, and GitHub attestation instance.

Dependency history, incident correlation, governance intelligence, graph queries,
batch, and compliance packs are experimental or indicative. There is no SLA.
