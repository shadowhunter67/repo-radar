# Cryptographic trust

Presence is not verification. A signature file, an attestation bundle or a checksum line proves nothing until a verifier with a named trust root accepted it. Every result states the trust root and who performed the check.

## States

`not_present`, `present_unverified`, `verified`, `invalid` (the verifier inspected it and rejected it), `verification_failed` (no decision: timeout, network, TUF, missing trust material, oversized input), `verification_unavailable` (no verifier or trust material here). `verification_failed` is neither a pass nor evidence of forgery.

## Trust roots (`src/trust/model.ts`)

`github_api_assertion`, `sigstore_public_good`, `user_supplied_key`, `project_pinned_key`, `system_trust_store`, `none`, `unknown`. Implemented now: the first two.

## What is verified

| Evidence | Without `--verify-crypto` | With `--verify-crypto` |
| -------- | ------------------------- | ---------------------- |
| Annotated git tag signature | GitHub's assertion is preserved (`trust_root: github_api_assertion`, `verified_by: github`); `local_state: verification_unavailable` (no pinned public key, no GPG run). GitHub's assertion is never presented as a local check. | unchanged |
| GitHub artifact attestation (Sigstore bundle) | `present_unverified`; statement parsed (subject digest, builder, source repo/revision) | verified by the maintained `sigstore` library against the Sigstore public-good root (certificate chain, DSSE signature, transparency-log evidence in the bundle). The signer identity (workflow of `owner/repo`) is parsed from the certificate. |
| Signature assets (`.asc`, `.sig`, `.minisig`, cosign bundles) | `present_unverified` | not verified yet |
| Asset bytes vs published digest | digests only | with `--verify-assets`: up to 3 assets, 8 MiB each, 24 MiB total are downloaded and hashed with the platform crypto library; larger ones are `verification_skipped_resource_limit` |

Weak digests (MD5, SHA-1) are recorded but never used as the expected value. `--verify-crypto` reaches `tuf-repo-cdn.sigstore.dev` (the library's TUF client) in addition to the normal hosts; bundles above 256 KiB are not passed to the verifier; each verification has a 20 s timeout. There is no custom cryptography anywhere.

## Source <-> artifact binding

`verified_source_binding` needs ALL of: a verified attestation, a subject digest equal to a published asset digest, a signer identity that is a CI workflow of the analyzed repository, and a source revision equal to the commit the release tag points to. Weaker classes keep weaker names: `verified_build_provenance` (no comparable revision), `source_binding_conflict` (genuine signature, other repository or revision), `digest_verified_only`, `attested_to_tag_commit` (UNVERIFIED attestation names the tag commit), `attestation_inconsistent`, `checksum_listed`, `tag_only`, `unlinked`. None says the artifact is reproducible.

## SLSA observations, not a level

`release.slsa` lists `provenance_present`, `provenance_verified`, `builder_identified`, `source_revision_bound`, `subject_digest_bound`, `build_service_identified` and `mapped_level: null`. repo-radar never reports "SLSA compliant" or a level: those need requirements (isolated, hermetic, non-falsifiable builds) that metadata cannot establish.

## Bounded binary metadata

For downloaded assets only: executable format (ELF/PE/Mach-O/script), architecture and platform from the first bytes, plus the archive directory (zip slip, bombs, symlinks, nested archives). Nothing is extracted, loaded or executed.

## Probes (default heads, 2026-10-11; `calibration/results/trust-probe.md`)

fd v10.5.0: 3 of 3 attestations `verified`, `verified_source_binding`. goreleaser v2.18.3: 1 `verified` (-> `verified_source_binding`), 3 `verification_failed` (a timestamp authority outside the configured trust root; initially mis-classified as `invalid`, fixed). cli/cli: 5 attestations listed, none readable (large bundles are served as snappy-compressed blobs on a storage host that is not fetched). ripgrep and cosign: tag signature `verified` by GitHub only; 3 ripgrep assets `checksum_verified`. axios, slsa-github-generator: no GitHub attestations. cosign publishes cosign bundles, which are not verified yet.

## Limitations

Sigstore blob bundles (`*.sigstore.json` next to assets), GPG/minisign/SSH signatures, local verification of git tag signatures, GitHub's own (private-instance) trust root, certificate revocation, and large non-inlined bundles are not handled.
