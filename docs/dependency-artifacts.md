# Dependency artifacts

`--inspect-dependency-artifacts` is an opt-in, static inspection of selected resolved npm, PyPI, and crates.io artifacts. URLs are restricted to ecosystem registry hosts and digests are checked before archive contents are read. Tar, gzip, and ZIP metadata are bounded in memory; files are never extracted, executed, installed, or followed through symlinks. ZIP64 is explicitly unsupported (`zip64_unsupported`) in this release.

The report distinguishes `verified`, `verification_unavailable`, `invalid`, `unsupported`, `failed`, and `skipped`. Coverage and skip reasons are always reported. Lifecycle hooks, bounded manifest metadata, file kinds, native magic, domains, and registry-manifest mismatches are observations, not intent or source-reproducibility claims. Nested archives are listed only.

Behavior and trust-boundary deltas require two same-package artifacts with verified digests. Unsupported file-level execution, native-binary, `bin`, repository-host, and publisher-organization comparisons remain `not_available`.
M3 metadata additions are static observations: executable-entry presence is not execution, native magic is not maliciousness, repository host comes only from the artifact manifest, and publisher organization remains unavailable without defensible registry evidence.
