# Release and provenance intelligence

`release_intel` describes what is published for the latest releases and what ties it to source. It records observations, never a conclusion that an artifact is authentic or reproducible.

## What is collected

For the latest 30 releases the GitHub list gives tags, publishers, assets and (when GitHub provides it) each asset's digest. The latest 3 get their tag resolved to a commit (and to its GitHub signature verification when the tag is annotated). The newest **stable** release (not a pre-release or nightly) also gets:

- up to 3 small checksum files (256 KiB cap) from this repository's own `releases/download/` URLs on `github.com` (redirects only to GitHub's asset hosts; any other host is refused),
- GitHub artifact attestations for up to 3 assets with a SHA-256 digest.

No asset binary is downloaded. Total release requests are capped at 24 and every limit that was hit is listed in `limits_hit`. A failed lookup is a limit, never "no signature".

## Entities

| Entity | Notes |
| ------ | ----- |
| Release | tag, publisher login, tag kind (lightweight / annotated / unresolved), tag commit |
| ReleaseAsset | kind (binary, archive, package, checksum, signature, attestation, sbom, other), size, content type, `suspicious_name` (control characters, traversal, non-ASCII) and `duplicate` |
| ArtifactDigest | algorithm, value, source (`github_api`, `checksum_file`), `weak` for MD5/SHA-1 (recorded, not counted as integrity evidence) |
| Signature | `signature_present`, `signature_verified`, `signature_invalid`, `verification_unavailable`; `verified_by: github` only for the tag signature GitHub verified; signature **assets** are `signature_present` and are not verified by repo-radar |
| Provenance | in-toto statement fields: subject digests, SLSA predicate, builder, source repository and revision; `verification` is always `verification_unavailable` |

## Source correspondence

`attested_to_tag_commit` (an attestation for an asset digest names the tag commit; its signature was not verified), `attestation_inconsistent` (an attestation names another revision), `checksum_listed` (a checksum file lists the asset: integrity of the download, not origin), `tag_only`, `unlinked`. None of these says the asset is byte-for-byte reproducible. The existence of provenance is not a SLSA level.

## Archive safety

`inspectArchive` reads only metadata of zip / tar / tar.gz bytes: names (zip slip, absolute paths, backslashes, control characters, bidi overrides), symlinks, duplicate names, nested archives, executables by extension, declared sizes, compression ratio, entry count (20 000), input size (25 MiB) and gunzip output (64 MiB). Nothing is extracted, written or executed. The collector does not download archives by default; the function exists for bounded verification.

## Known limitations

- GitHub returns large attestation bundles as a `bundle_url` on a storage host that is not allowlisted; such attestations are counted (`attestations_listed`) but their statement is not read (cli/cli is an example).
- Attestation envelopes are verified only with `--verify-crypto` (see trust.md); tag signatures are verified only by GitHub; GPG / Sigstore-blob / minisign signature assets are not verified.
- `.intoto.jsonl` assets (SLSA generator output) are classified but not parsed.
- Only GitHub releases are analyzed; tags without a release and registry publishers are future work.


## Update (0.6): verification states and binding classes

Signature and provenance states are now the shared trust vocabulary of [trust.md](trust.md): `not_present`, `present_unverified`, `verified`, `invalid`, `verification_failed`, `verification_unavailable`, each with its trust root. The earlier names (`signature_present`, `signature_verified`, `signature_invalid`) are retired. A tag signature GitHub verified is `verified` with `trust_root: github_api_assertion` and `local_state: verification_unavailable`. New correspondence classes: `verified_source_binding`, `verified_build_provenance`, `source_binding_conflict`, `digest_verified_only`. Each release also carries `slsa` (individual observations, never a level) and, with `--verify-assets`, `asset_checks` with bounded format/architecture metadata.
