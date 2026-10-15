# Cryptographic trust

Presence is not verification. A signature file, an attestation bundle, a checksum line or a public key found in a repository proves nothing until a verifier with a named trust root accepted it. Every result states the trust root, the engine and the subject.

## States

`not_present`, `present_unverified` (nobody checked it), `verified` (a verifier accepted it against the stated trust root), `invalid` (the verifier inspected it and rejected it: bad signature, untrusted chain, expired certificate or key, wrong signer identity), `verification_failed` (no decision: timeout, network, TUF, unparsable input, trust material outside the configured root), `verification_unavailable` (no verifier, no key, or the signer is not among the trusted ones), `verification_skipped_resource_limit` (a size or count limit stopped the check BEFORE a decision). `verification_failed`, `verification_unavailable` and `verification_skipped_resource_limit` are neither a pass nor evidence of forgery. Missing trust material is never mapped to `invalid`.

## Trust roots (`src/trust/model.ts`)

| Trust root | Meaning |
| ---------- | ------- |
| `github_api_assertion` | GitHub told us (its tag `verification` object). GitHub's word, never presented as a local check. |
| `sigstore_public_good` | Sigstore's public-good instance (Fulcio + Rekor material from the Sigstore TUF root), verified by the maintained `sigstore` library. |
| `user_supplied_gpg_key` / `user_supplied_minisign_key` | a PUBLIC key YOU gave this run (`--trust-gpg-key`, `--trust-minisign-key`) |
| `project_pinned_gpg_key` / `project_pinned_minisign_key` | a public key in a trust file YOU maintain outside the analyzed repository (`--trust-config`), optionally pinned by fingerprint |
| `system_trust_store`, `none`, `unknown` | reserved / no trust material |

A result looks like `{state, trust_root, engine, subject, verified_by, detail, identity}` where `engine` is `sigstore`, `openpgp`, `minisign`, `github_api` or `none`.

## Trust configuration is never read from the repository

Keys and the expected signer identity come only from the person running repo-radar: command-line flags and a trust file (`--trust-config`, JSON: `{"keys": [{"kind": "gpg" | "minisign", "file" | "material": ..., "fingerprint": ...}], "expected_identity": {"source_repository": ..., "san": ..., "issuer": ...}}`; unknown fields are rejected). **A public key committed in the repository is evidence only**: it is listed in `release_intel.key_material_in_repository` as `key_present_in_repository` with `trusted: false`, is never fetched, and never becomes a trust root. There is no host keyring lookup either, so a result does not depend on whatever keys exist on the machine. Private key material (an OpenPGP private key block, a minisign secret key) is **refused** at load and can never reach a report, snapshot or graph; reports record only how many trusted keys were configured. A fingerprint pin names the PRIMARY key: a key file that holds several keys (restic publishes an old and a new key together) is read key by key and only the pinned one is trusted. A trusted key must be valid NOW: an expired or revoked key is `invalid`, because a signature date chosen by the signer cannot prove the signature was made earlier.

## What is verified

| Evidence | Without options | With options |
| -------- | --------------- | ------------ |
| Annotated git tag signature | GitHub's assertion preserved (`github_api_assertion`, `verified_by: github`); `local_state: verification_unavailable` ("a signed tag is present but no trusted GPG key was supplied") | with a trusted GPG key, the signature and the exact signed payload that GitHub returns are verified LOCALLY by OpenPGP (`basis: local_crypto_verified`); SSH and S/MIME tag signatures stay unverified |
| GitHub artifact attestation (Sigstore DSSE bundle) | `present_unverified`; statement parsed | `--verify-crypto`: verified by `sigstore` (certificate chain, DSSE signature, transparency-log evidence); signer identity parsed |
| Large attestation bundles | counted (`not inlined`) | `--verify-crypto` or not, the bundle GitHub serves from its attestation store is downloaded (see below) |
| Sigstore BLOB bundle (`app.tar.gz.sigstore.json`, `checksums.txt.sigstore.json`) | `present_unverified` | `--verify-crypto`: the signed asset is downloaded (bounded), its SHA-256 compared with the digest the bundle signs (a different artifact is `invalid` before the verifier is asked), then verified by `sigstore` against the public-good root |
| OpenPGP detached signature (`.asc`, `.sig`) | `present_unverified` | with a trusted GPG key: verified by `openpgp` (weak hashes MD5, RIPEMD and SHA-1 rejected) |
| minisign (`.minisig`) | `present_unverified` | with a trusted minisign key: Ed25519 and the global (trusted-comment) signature verified with the platform crypto; a `.minisig` alone is not trust |
| cosign key signatures, X.509, SSH signature files | `present_unverified` | `verification_unavailable` |
| Asset bytes vs published digest | digests only | `--verify-assets`: up to 3 assets, 8 MiB each, 24 MiB total |

Signature identity: with `expected_identity.source_repository` (or `san` / `issuer`) set, a cryptographically valid Sigstore signature by any OTHER identity is `invalid` ("valid signature, but signed by X, expected Y"). Without an expectation the signer is reported (`identity.source_repository`) and not judged.

## Resource limits (`verification_skipped_resource_limit`)

Bundle 256 KiB; at most 8 certificates, 4 transparency-log entries, 64 subjects; 20 s timeout; a bundle that cannot even be serialized (cycles, extreme nesting) is skipped. Detached signatures: signature 64 KiB (OpenPGP) / 4 KiB (minisign) / 256 KiB (Sigstore bundle); signed artifact 8 MiB each, 24 MiB in total (shared with `--verify-assets`, whose bytes are reused); at most 6 signature assets per release; key files 1 MiB and 16 keys. Beyond a limit the result says so, it never says verified.

## Large attestation bundles

GitHub returns a large bundle as a short-lived signed `bundle_url` in its own attestation store (`tmaproduction.blob.core.windows.net`, Snappy-compressed JSON) instead of inline. That is the only other host fetched, with a dedicated credential-free client, and only for a URL that passes a strict check (https, that host, no userinfo, no port, a path under `/attestations/`, no traversal). Downloads are capped at 512 KiB compressed and 1 MiB decompressed, five per release; the Snappy decoder (`src/util/snappy.ts`) rejects a declared length over the cap before allocating anything and bounds-checks every copy. A bundle over a limit becomes an explicit record with `verification_skipped_resource_limit` instead of being dropped. The URL's query string is a signature: it is never stored or printed.

## Source <-> artifact binding

`verified_source_binding` needs ALL of: a verified attestation, a subject digest equal to a published asset digest, a signer identity that is a CI workflow of the analyzed repository, and a source revision equal to the commit the release tag points to. Weaker classes keep weaker names: `verified_build_provenance`, `source_binding_conflict`, `digest_verified_only`, `attested_to_tag_commit`, `attestation_inconsistent`, `checksum_listed`, `tag_only`, `unlinked`. None says the artifact is reproducible.

## SLSA observations, not a level

`release.slsa` lists `provenance_present`, `provenance_verified`, `builder_identified`, `source_revision_bound`, `subject_digest_bound`, `build_service_identified` and `mapped_level: null`. repo-radar never reports "SLSA compliant" or a level.

## Provenance: which evidence stands behind a signature (`basis`)

`local_crypto_verified` (repo-radar verified it against a configured trust root), `github_api_verified` (only GitHub said so), `present_unverified`, `not_verified` (a check ran and did not accept it, or could not decide). Both `state`/`trust_root` (the aggregate, GitHub's assertion for a tag) and `local_state`/`local_detail` (repo-radar's own check) are kept.

## Real probes (`calibration/results/crypto-probe.md`, 2026-10-13; first run kept as `crypto-probe-first-run.md`)

Every outcome is recorded, including those that did not verify:

| Case | Outcome |
| ---- | ------- |
| goreleaser v2.18.3 Sigstore blob bundle over `checksums.txt` | **verified** by Sigstore public-good; with a wrong expected identity: **invalid** ("valid signature, but signed by goreleaser/goreleaser, expected someone-else/other-repo") |
| goreleaser, GitHub release attestations (`in-toto.io/attestation/release/v0.2`) | `verification_failed` x3: signed under GitHub's own Sigstore instance, whose timestamp authority is outside the public-good root - not a pass, not a rejection |
| restic v0.19.1 `SHA256SUMS.asc` and the signed tag | **verified** locally against the key pinned by fingerprint (the key file holds the old and the new key); wrong fingerprint pin -> `verification_failed` (nothing verified); no trust -> `present_unverified` |
| dnscrypt-proxy 2.1.18 minisign | 5 signatures **verified** with the key from the project README; the rest `verification_skipped_resource_limit` (24 MiB total limit) |
| cli/cli v2.102.0 attestations | the 5 large bundles are downloaded: 2 SLSA provenance **verified** (signer cli/cli, `verified_source_binding`), 3 release attestations `verification_failed` (GitHub's own instance) |
| sharkdp/fd | checksum-only: 3 attestations `present_unverified` without `--verify-crypto` |

The first run exposed three defects, since fixed with tests: a Sigstore bundle named like a checksum file (`checksums.txt.sigstore.json`) was classified as a checksum file; a key file holding several keys was read as its first (revoked) key; large bundles were not downloaded.

## Limitations

GitHub's own (private-instance) trust root is not implemented, so its release attestations stay `verification_failed`; no certificate revocation checking; SSH and S/MIME tag signatures, cosign key-based signatures and X.509 signature files are not verified; dependency attestations are not verified (registries only REPORT provenance); verification is per release asset, not a verification of the whole release; `--verify-crypto` reaches `tuf-repo-cdn.sigstore.dev`. There is no custom cryptography: Sigstore through `sigstore`, OpenPGP through `openpgp` (LGPL-3.0-or-later, used unmodified as a library), Ed25519 and hashes through `node:crypto`; the minisign container format is parsed in `src/trust/minisign.ts`.
# GitHub attestation instance trust root

GitHub release attestations are verified only against the separately supplied `github_attestation_instance` trusted root, selected from a user-provided trusted-root JSONL file by the Fulcio CA URI `fulcio.githubapp.com`. The fixture in `tests/fixtures/attestations/github-trusted-root.jsonl` is test data only and is never loaded by production code.

This instance is verified with `ctlogThreshold: 0`, `tlogThreshold: 0`, and `timestampThreshold: 1`. GitHub-instance certificates carry no SCT and these release bundles use signed timestamps rather than Rekor inclusion proofs. Consequently, verification does not establish transparency-log inclusion; trust rests on GitHub's timestamp authority and CA. The certificate-bound SAN, issuer, workflow/repository identity, ref, and commit are retained only when exposed cryptographically by the verifier; unsigned statement claims remain `claimed`.
