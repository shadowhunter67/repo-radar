# Cryptographic verification probe: crypto-probe

Run 2026-10-13T15:02:30.215Z. Every case is recorded as it came out. Trust material is supplied as a user would supply it; nothing is read from the analyzed repository.

## goreleaser/goreleaser - Sigstore keyless BLOB bundle over checksums.txt (message signature, GitHub Actions identity)

- time 17963 ms; release v2.18.3; verification run {"attestations":true,"assets":true,"signatures":true,"trusted_keys":0}; repository key files: none
- signature tag [gpg]: state verified, local verification_unavailable, basis github_api_verified, root github_api_assertion / engine none, local root none: the tag signature is not an OpenPGP signature; other formats are not verified
- signature checksums.txt [sigstore]: state verified, local verified, basis local_crypto_verified, root sigstore_public_good / engine sigstore, local root sigstore_public_good: certificate chain, signature over the artifact digest and transparency-log evidence accepted
- attestation https://in-toto.io/attestation/release/v0.2: verification_failed (sigstore_public_good; timestamp could not be verified; signer n/a)
- attestation https://in-toto.io/attestation/release/v0.2: verification_failed (sigstore_public_good; timestamp could not be verified; signer n/a)
- attestation https://slsa.dev/provenance/v1: verified (sigstore_public_good; certificate chain, signature and transparency-log evidence accepted; signer goreleaser/goreleaser)
- attestation https://in-toto.io/attestation/release/v0.2: verification_failed (sigstore_public_good; timestamp could not be verified; signer n/a)
- asset goreleaser-2.18.3-1.aarch64.rpm: verification_skipped_resource_limit
- asset goreleaser-2.18.3-1.armv7hl.rpm: verification_skipped_resource_limit
- asset goreleaser-2.18.3-1.i386.rpm: verification_skipped_resource_limit
- asset goreleaser-2.18.3-1.loongarch64.rpm: verification_skipped_resource_limit
- asset goreleaser-2.18.3-1.ppc64.rpm: verification_skipped_resource_limit
- asset goreleaser-2.18.3-1.riscv64.rpm: verification_skipped_resource_limit
- asset goreleaser-2.18.3-1.x86_64.rpm: verification_skipped_resource_limit
- asset goreleaser_2.18.3_aarch64.apk: verification_skipped_resource_limit
- asset goreleaser_2.18.3_amd64.deb: verification_skipped_resource_limit
- asset goreleaser_2.18.3_arm64.deb: verification_skipped_resource_limit
- correspondence verified_source_binding; limits: tags resolved for 3 of 30 releases

## goreleaser/goreleaser - the same release with an EXPECTED identity that is wrong (a valid signature by someone else is invalid)

- time 10374 ms; release v2.18.3; verification run {"attestations":true,"assets":false,"signatures":true,"trusted_keys":0}; repository key files: none
- signature tag [gpg]: state verified, local verification_unavailable, basis github_api_verified, root github_api_assertion / engine none, local root none: the tag signature is not an OpenPGP signature; other formats are not verified
- signature checksums.txt [sigstore]: state invalid, local invalid, basis not_verified, root sigstore_public_good / engine sigstore, local root sigstore_public_good: valid signature, but signed by goreleaser/goreleaser, expected someone-else/other-repo
- attestation https://in-toto.io/attestation/release/v0.2: verification_failed (sigstore_public_good; timestamp could not be verified; signer n/a)
- attestation https://in-toto.io/attestation/release/v0.2: verification_failed (sigstore_public_good; timestamp could not be verified; signer n/a)
- attestation https://slsa.dev/provenance/v1: verified (sigstore_public_good; certificate chain, signature and transparency-log evidence accepted; signer goreleaser/goreleaser)
- attestation https://in-toto.io/attestation/release/v0.2: verification_failed (sigstore_public_good; timestamp could not be verified; signer n/a)
- correspondence verified_source_binding; limits: tags resolved for 3 of 30 releases

## restic/restic - OpenPGP detached signature (SHA256SUMS.asc), verified against the key pinned by fingerprint

- time 10041 ms; release v0.19.1; verification run {"attestations":false,"assets":true,"signatures":true,"trusted_keys":1}; repository key files: none
- signature tag [gpg]: state verified, local verified, basis local_crypto_verified, root github_api_assertion / engine openpgp, local root project_pinned_gpg_key: valid signature by trusted key 91A6868BD3F7A907
- signature restic-0.19.1.tar.gz [gpg]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: the signed asset is 24166058 bytes (limit 8388608); not downloaded
- signature SHA256SUMS [gpg]: state verified, local verified, basis local_crypto_verified, root project_pinned_gpg_key / engine openpgp, local root project_pinned_gpg_key: valid signature by trusted key 91A6868BD3F7A907
- asset restic-0.19.1.tar.gz: verification_skipped_resource_limit
- asset restic_0.19.1_aix_ppc64.bz2: verification_skipped_resource_limit
- asset restic_0.19.1_darwin_amd64.bz2: verification_skipped_resource_limit
- asset restic_0.19.1_darwin_arm64.bz2: verification_skipped_resource_limit
- asset restic_0.19.1_dragonfly_amd64.bz2: verification_skipped_resource_limit
- asset restic_0.19.1_freebsd_386.bz2: verification_skipped_resource_limit
- asset restic_0.19.1_freebsd_amd64.bz2: verification_skipped_resource_limit
- asset restic_0.19.1_freebsd_arm.bz2: verification_skipped_resource_limit
- asset restic_0.19.1_linux_386.bz2: verification_skipped_resource_limit
- asset restic_0.19.1_linux_amd64.bz2: verification_skipped_resource_limit
- correspondence checksum_listed; limits: tags resolved for 3 of 30 releases

## restic/restic - the same release, WRONG pinned fingerprint (the key must be rejected, nothing may verify)

- time 9470 ms; release v0.19.1; verification run {"attestations":false,"assets":false,"signatures":true,"trusted_keys":1}; repository key files: none
- signature tag [gpg]: state verified, local verification_failed, basis github_api_verified, root github_api_assertion / engine openpgp, local root none: none of the 1 configured GPG key(s) could be used (1 unreadable or failed the fingerprint pin)
- signature restic-0.19.1.tar.gz [gpg]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: the signed asset is 24166058 bytes (limit 8388608); not downloaded
- signature SHA256SUMS [gpg]: state verification_failed, local verification_failed, basis not_verified, root none / engine openpgp, local root none: none of the 1 configured GPG key(s) could be used (1 unreadable or failed the fingerprint pin)
- correspondence checksum_listed; limits: tags resolved for 3 of 30 releases

## restic/restic - the same release with NO trust configured: signatures present but unverified

- time 8350 ms; release v0.19.1; verification run {"attestations":false,"assets":false,"signatures":false,"trusted_keys":0}; repository key files: none
- signature tag [gpg]: state verified, local verification_unavailable, basis github_api_verified, root github_api_assertion / engine none, local root none: a signed tag is present but no trusted GPG key was supplied
- signature restic-0.19.1.tar.gz [gpg]: state present_unverified, local present_unverified, basis present_unverified, root none
- signature SHA256SUMS [gpg]: state present_unverified, local present_unverified, basis present_unverified, root none
- correspondence checksum_listed; limits: tags resolved for 3 of 30 releases

## DNSCrypt/dnscrypt-proxy - minisign signatures next to release archives, verified against the key published in the project README

- time 15357 ms; release 2.1.18; verification run {"attestations":false,"assets":false,"signatures":true,"trusted_keys":1}; repository key files: none
- signature tag [gpg]: state verified, local verification_unavailable, basis github_api_verified, root github_api_assertion / engine none, local root none: a signed tag is present but no trusted GPG key was supplied
- signature dnscrypt-proxy-android_arm-2.1.18.zip [minisign]: state verified, local verified, basis local_crypto_verified, root user_supplied_minisign_key / engine minisign, local root user_supplied_minisign_key: valid signature by trusted minisign key e4d715ea71338379
- signature dnscrypt-proxy-android_arm64-2.1.18.zip [minisign]: state verified, local verified, basis local_crypto_verified, root user_supplied_minisign_key / engine minisign, local root user_supplied_minisign_key: valid signature by trusted minisign key e4d715ea71338379
- signature dnscrypt-proxy-android_i386-2.1.18.zip [minisign]: state verified, local verified, basis local_crypto_verified, root user_supplied_minisign_key / engine minisign, local root user_supplied_minisign_key: valid signature by trusted minisign key e4d715ea71338379
- signature dnscrypt-proxy-android_x86_64-2.1.18.zip [minisign]: state verified, local verified, basis local_crypto_verified, root user_supplied_minisign_key / engine minisign, local root user_supplied_minisign_key: valid signature by trusted minisign key e4d715ea71338379
- signature dnscrypt-proxy-dragonflybsd_amd64-2.1.18.tar.gz [minisign]: state verified, local verified, basis local_crypto_verified, root user_supplied_minisign_key / engine minisign, local root user_supplied_minisign_key: valid signature by trusted minisign key e4d715ea71338379
- signature dnscrypt-proxy-freebsd_amd64-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-freebsd_arm-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-freebsd_arm64-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-freebsd_i386-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-linux_arm-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-linux_arm64-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-linux_i386-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-linux_loong64-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-linux_mips-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-linux_mips64-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-linux_mips64le-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-linux_mipsle-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-linux_riscv64-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-linux_x86_64-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-macos_arm64-2.1.18.zip [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-macos_x86_64-2.1.18.zip [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-netbsd_amd64-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-netbsd_i386-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-openbsd_amd64-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-openbsd_i386-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-solaris_amd64-2.1.18.tar.gz [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-win32-2.1.18.zip [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-win64-2.1.18.zip [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- signature dnscrypt-proxy-winarm-2.1.18.zip [minisign]: state verification_skipped_resource_limit, local verification_skipped_resource_limit, basis not_verified, root none / engine none, local root none: total download limit reached
- correspondence tag_only; limits: tags resolved for 3 of 30 releases

## cli/cli - GitHub artifact attestations (Sigstore DSSE bundles), with asset checksum verification

- time 12617 ms; release v2.102.0; verification run {"attestations":true,"assets":true,"signatures":false,"trusted_keys":0}; repository key files: none
- attestation https://in-toto.io/attestation/release/v0.2: verification_failed (sigstore_public_good; timestamp could not be verified; signer n/a)
- attestation https://in-toto.io/attestation/release/v0.2: verification_failed (sigstore_public_good; timestamp could not be verified; signer n/a)
- attestation https://slsa.dev/provenance/v1: verified (sigstore_public_good; certificate chain, signature and transparency-log evidence accepted; signer cli/cli)
- attestation https://in-toto.io/attestation/release/v0.2: verification_failed (sigstore_public_good; timestamp could not be verified; signer n/a)
- attestation https://slsa.dev/provenance/v1: verified (sigstore_public_good; certificate chain, signature and transparency-log evidence accepted; signer cli/cli)
- asset gh_2.102.0_linux_386.deb: verification_skipped_resource_limit
- asset gh_2.102.0_linux_386.rpm: verification_skipped_resource_limit
- asset gh_2.102.0_linux_386.tar.gz: verification_skipped_resource_limit
- asset gh_2.102.0_linux_amd64.deb: verification_skipped_resource_limit
- asset gh_2.102.0_linux_amd64.rpm: verification_skipped_resource_limit
- asset gh_2.102.0_linux_amd64.tar.gz: verification_skipped_resource_limit
- asset gh_2.102.0_linux_arm64.deb: verification_skipped_resource_limit
- asset gh_2.102.0_linux_arm64.rpm: verification_skipped_resource_limit
- asset gh_2.102.0_linux_arm64.tar.gz: verification_skipped_resource_limit
- asset gh_2.102.0_linux_armv6.deb: verification_skipped_resource_limit
- correspondence verified_source_binding; limits: 5 large attestation bundle(s) were downloaded from GitHub's attestation store (Snappy, bounded); tags resolved for 3 of 30 releases

## sharkdp/fd - checksum-only release (no signature, no attestation expected)

- time 8172 ms; release v10.5.0; verification run {"attestations":false,"assets":true,"signatures":false,"trusted_keys":0}; repository key files: none
- attestation https://slsa.dev/provenance/v1: present_unverified
- attestation https://slsa.dev/provenance/v1: present_unverified
- attestation https://slsa.dev/provenance/v1: present_unverified
- asset fd-musl_10.5.0_amd64.deb: checksum_verified, 1288170 bytes
- asset fd-musl_10.5.0_arm64.deb: checksum_verified, 1165488 bytes
- asset fd-musl_10.5.0_armhf.deb: checksum_verified, 1211906 bytes
- asset fd-musl_10.5.0_i686.deb: verification_skipped_resource_limit
- asset fd-v10.5.0-aarch64-apple-darwin.tar.gz: verification_skipped_resource_limit
- asset fd-v10.5.0-aarch64-pc-windows-msvc.zip: verification_skipped_resource_limit
- asset fd-v10.5.0-aarch64-unknown-linux-gnu.tar.gz: verification_skipped_resource_limit
- asset fd-v10.5.0-aarch64-unknown-linux-musl.tar.gz: verification_skipped_resource_limit
- asset fd-v10.5.0-arm-unknown-linux-gnueabihf.tar.gz: verification_skipped_resource_limit
- asset fd-v10.5.0-arm-unknown-linux-musleabihf.tar.gz: verification_skipped_resource_limit
- correspondence attested_to_tag_commit; limits: tags resolved for 3 of 30 releases

## Tally of states seen

- verification_unavailable: 4
- verified: 12
- verification_failed: 11
- invalid: 1
- verification_skipped_resource_limit: 26
- present_unverified: 5
