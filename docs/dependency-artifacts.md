# Dependency artifacts

`--inspect-dependency-artifacts` is an opt-in, static inspection of selected resolved npm, PyPI, and crates.io artifacts. URLs are restricted to ecosystem registry hosts and digests are checked before archive contents are read. Tar, gzip, and ZIP metadata are streamed in memory; files are never extracted, executed, installed, or followed through symlinks.

The report distinguishes `verified`, `verification_unavailable`, `invalid`, `unsupported`, `failed`, and `skipped`. Coverage and skip reasons are always reported. Lifecycle hooks, bounded manifest metadata, file kinds, native magic, domains, and registry-manifest mismatches are observations, not intent or source-reproducibility claims. Nested archives are listed only.
