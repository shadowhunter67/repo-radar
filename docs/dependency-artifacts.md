# Dependency artifacts

`--inspect-dependency-artifacts` is an opt-in, static inspection of selected resolved npm, PyPI, and crates.io artifacts. URLs are restricted to ecosystem registry hosts and digests are checked before archive contents are read. Tar, gzip, and ZIP metadata are bounded in memory; files are never extracted, executed, installed, or followed through symlinks. ZIP64 is explicitly unsupported (`zip64_unsupported`) in this release.

The report distinguishes `verified`, `verification_unavailable`, `invalid`, `unsupported`, `failed`, and `skipped`. Coverage and skip reasons are always reported. Lifecycle hooks, bounded manifest metadata, file kinds, native magic, domains, and registry-manifest mismatches are observations, not intent or source-reproducibility claims. Nested archives are listed only.

Behavior and trust-boundary deltas require two same-package artifacts with verified digests. Unsupported file-level execution, native-binary, `bin`, repository-host, and publisher-organization comparisons remain `not_available`.
M3 metadata additions are static observations: executable-entry presence is not execution, native magic is not maliciousness, repository host comes only from the artifact manifest, and publisher organization remains unavailable without defensible registry evidence.
## Historical artifact provenance

Historical artifact observations carry an explicit provenance class: `live_registry`, official registry/release archive, security-research archive, third-party mirror, `reproducible_fixture`, `synthetic_fixture`, `unverified_historical_artifact`, or `unavailable`. A matching digest is required for `verified`; a mirror without an independently known digest is forced to `unverified_historical_artifact` and cannot support source binding or high-confidence conclusions. A live 404 is recorded as `artifact_unavailable_from_live_registry`, not as proof that a release never existed.

This release implements only the existing live-registry path and a local pinned-fixture adapter. Remote mirrors, malware repositories, and security-research archives are intentionally rejected: their custody, repackaging, redirects, content limits, and independent digest/timestamp verification are not defensible offline. Future adapters must enforce the central host allowlist, size/content-type/redirect/private-IP limits, expected digest, operator identity, and original-versus-repackaged status.
